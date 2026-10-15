/**
 * Close-out (§6.5, ADR-0007): lock, export, the grace period, the purge, corrections after close and retention.
 * Plain TS; Discord only through the port, other modules only through their services, files only in the exports
 * folder. Deleting a channel can't be undone, so nothing here deletes one unless the purge gate passed for it.
 */
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { type AccessPlan, type Principal, type Resource, canSee, isOrganizer } from '../../../shared/access/access';
import {
  DAY_MS,
  type PurgeFacts,
  type RefusalReason,
  type TranscriptJson,
  TRANSCRIPT_VERSION,
  isNewer,
  purgeDecision,
  renderTranscriptHtml,
  retentionDue,
  safeDownloadName,
} from '../../../shared/closeout';
import { isLocked } from '../../../shared/discord/lock';
import { missingPermissions } from '../../../shared/discord/permissions';
import { can, effectivePermissions } from '../../../shared/discord/resolve';
import { TOURNAMENT_ID } from '../../../shared/penalties';
import type { Db } from '../../db/client';
import { DiscordAuthError, type DiscordGateway, DiscordUnavailableError, type HistoryMessage } from '../discord/port';
import { ServiceError, notFound } from '../errors';
import type { EventDaysService, EventView } from '../event-days';
import type { JobContext, JobKind, Jobs } from '../jobs/jobs';
import type { PenaltiesService, PenaltyPatch, PenaltyView } from '../penalties';
import type { Binding, ProvisioningService } from '../provisioning';
import type { AttachmentFetcher } from './adapters/cdn';
import { exportsFolder } from './files';
import { type AttachmentRow, type FailureKind, type FileRow, createCloseoutStore } from './store';

const HOUR_MS = 3_600_000;
const MIB = 1024 * 1024;
/** The application flags of the Message Content intent (on, or limited). */
const MESSAGE_CONTENT_FLAGS = (1 << 18) | (1 << 19);
const IN_FLIGHT: readonly JobKind[] = ['lock', 'export', 'reexport', 'attachments_retry'];

export interface CloseOutSettings {
  transcriptRetentionDays: number;
  penaltyRetentionDays: number;
  attachmentCapMb: number;
}
export type CloseOutSettingsView = CloseOutSettings & { purgeGraceHours: number };

export type CloseoutAlarm =
  | { kind: 'closeout_failed'; dayId: number; title: string; jobKind: FailureKind; since: number }
  | { kind: 'purge_refused'; dayId: number; title: string; reasons: number; since: number };

export interface ClosePreflight {
  recentPenalties: { penaltyId: number; eventId: number; number: number; recordedAt: number }[];
  csvBlocked: { eventId: number; name: string }[];
  channels: number;
}

/** A refused purge: the job fails, but it isn't a close-out failure (the refusal has its own alarm). */
class PurgeRefused extends Error {
  override name = 'PurgeRefused';
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createCloseoutService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  eventDays: EventDaysService;
  provisioning: ProvisioningService;
  penalties: PenaltiesService;
  jobs: Jobs;
  gateway: () => DiscordGateway;
  binding: () => Binding | null;
  exportsDir: string;
  graceMs: number;
  settings: {
    get(): { transcriptRetentionDays: number; penaltyRetentionDays: number; attachmentCapBytes: number };
    put(s: { transcriptRetentionDays: number; penaltyRetentionDays: number; attachmentCapBytes: number }, now: number): void;
  };
  fetcher: AttachmentFetcher;
  /** Tests hold a CSV write mid-way to race it against a correction. */
  testHooks?: { beforeCsvWrite?: (eventId: number) => Promise<void> };
}) {
  const { db, clock, logger, eventDays, provisioning, penalties, jobs, gateway, binding, graceMs, fetcher } = opts;
  const store = createCloseoutStore(db);
  const folder = exportsFolder(opts.exportsDir);

  function requireBinding(): Binding {
    const b = binding();
    if (!b) throw new ServiceError(409, 'setup_incomplete', 'Finish setup first.');
    return b;
  }
  const unreachable = () => new ServiceError(503, 'discord_unavailable', 'Discord could not be reached. Try again in a moment.');
  const plan = (dayId: number) => eventDays.plan(dayId);

  // ---- alerts and failures (§6.5 "Where alerts go")

  /** Posts to the day's head-judges channel while it exists; the post is recorded so the purge ignores it. */
  async function alert(dayId: number, text: string): Promise<void> {
    const channelId = provisioning.headJudgesChannel(dayId);
    if (!channelId) return;
    try {
      const messageId = await gateway().postMessage(channelId, { content: `Close-out of ${plan(dayId).day.title}: ${text}. Organizers: see the day’s Exports page.` });
      store.addAlertMessage(dayId, messageId);
    } catch (err) {
      logger.warn('Could not post a close-out alert.', { dayId, err: errorText(err) });
    }
  }

  async function recordFailure(dayId: number, kind: FailureKind, err: unknown): Promise<void> {
    store.setFailure(dayId, { kind, error: errorText(err), at: clock.now() });
    await alert(dayId, `the ${kind.replace('_', ' ')} step failed`);
  }

  function clearFailure(dayId: number, kind: FailureKind): void {
    const failure = store.closeout(dayId).lastFailure;
    if (failure && (JSON.parse(failure) as { kind: FailureKind }).kind === kind) store.setFailure(dayId, null);
  }

  /** A job handler that records its failure for the alarm and clears it on success. */
  const job =
    (kind: FailureKind, body: (ctx: JobContext) => Promise<void>) =>
    async (ctx: JobContext): Promise<void> => {
      try {
        await body(ctx);
      } catch (err) {
        if (ctx.dayId !== null && !(err instanceof PurgeRefused)) await recordFailure(ctx.dayId, kind, err);
        throw err;
      }
      if (ctx.dayId !== null) clearFailure(ctx.dayId, kind);
    };

  // ---- runs and files

  /** Files and rows of the day's failed runs go before a new run starts (never a run still writing). */
  async function cleanup(dayId: number): Promise<void> {
    for (const run of store.failedRuns(dayId)) {
      await folder.removeRun(dayId, run.id);
      store.deleteRun(run.id);
    }
  }

  const csvLocks = new Map<number, Promise<unknown>>();
  /** One CSV write per event at a time (§6.5 corrections, FR-31's lock). */
  function withCsvLock<T>(eventId: number, work: () => Promise<T>): Promise<T> {
    const previous = csvLocks.get(eventId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    csvLocks.set(eventId, tail);
    void tail.then(() => {
      if (csvLocks.get(eventId) === tail) csvLocks.delete(eventId);
    });
    return next;
  }

  /** The event's penalties CSV and voided CSV in this run; the penalties CSV's row, or `null` without a Tournament ID. */
  async function writeCsvs(runId: number, dayId: number, ev: EventView): Promise<number | null> {
    if (!ev.tournamentId || !TOURNAMENT_ID.test(ev.tournamentId)) return null;
    return withCsvLock(ev.id, async () => {
      const sourceRevision = penalties.sourceRevision(ev.id);
      const bodies = [false, true].map((voided) => ({ voided, csv: penalties.csv(dayId, ev.id, voided) }));
      // Between reading the penalties and writing them, a correction may commit: the source revision settles it.
      await opts.testHooks?.beforeCsvWrite?.(ev.id);
      let fileId: number | null = null;
      for (const { voided, csv } of bodies) {
        const path = folder.pathFor(dayId, runId, 'csv', ev.id, voided ? '-voided.csv' : '.csv');
        const written = await folder.write(path, csv.body);
        const id = store.insertFile({
          dayId,
          runId,
          kind: voided ? 'penalties_voided_csv' : 'penalties_csv',
          eventId: ev.id,
          sourceRevision,
          name: csv.filename,
          path,
          downloadName: csv.filename,
          sha256: written.sha256,
          bytes: written.bytes,
          createdAt: clock.now(),
        });
        if (!voided) fileId = id;
      }
      return fileId;
    });
  }

  /** Every message of a channel or thread, oldest first; `null` once it is gone. */
  async function readAll(discord: DiscordGateway, channelId: string): Promise<HistoryMessage[] | null> {
    const all: HistoryMessage[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await discord.readHistory(channelId, before);
      if (page === null) return null;
      all.push(...page);
      if (page.length < 100) break;
      before = page.at(-1)!.id;
    }
    return all.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  interface Holder {
    channelId: string;
    threadId: string | null;
    name: string;
    eventId: number | null;
    key: string;
    thread: { type: 'public' | 'private'; archived: boolean } | null;
  }

  /** A transcript as JSON and HTML in this run; answers the JSON row's ID. */
  async function writeTranscript(runId: number, dayId: number, holder: Holder, messages: HistoryMessage[], contentIntent: boolean): Promise<number> {
    const day = plan(dayId).day;
    const mark = messages.at(-1)?.id ?? null;
    const transcript: TranscriptJson = {
      version: TRANSCRIPT_VERSION,
      exportedAt: new Date(clock.now()).toISOString(),
      contentIntent,
      day: { id: day.id, date: day.date, title: day.title },
      channel: { id: holder.threadId ?? holder.channelId, name: holder.name, parentChannelId: holder.threadId ? holder.channelId : null, thread: holder.thread },
      highWaterMessageId: mark,
      messages: messages.map((m) => ({
        id: m.id,
        type: m.type,
        authorId: m.authorId,
        authorName: m.authorName,
        authorBot: m.authorBot,
        createdAt: new Date(m.createdAt).toISOString(),
        editedAt: m.editedAt === null ? null : new Date(m.editedAt).toISOString(),
        content: m.content,
        referencedMessageId: m.referencedMessageId,
        embeds: m.embeds,
        attachments: m.attachments,
      })),
    };
    const folderName = holder.threadId ? 'threads' : 'transcripts';
    const id = holder.threadId ?? holder.channelId;
    const base = safeDownloadName(`${day.date}-${holder.name}`, `${day.date}-transcript`);
    const common = {
      dayId,
      runId,
      eventId: holder.eventId,
      channelId: holder.channelId,
      threadId: holder.threadId,
      parentChannelId: holder.threadId ? holder.channelId : null,
      blueprintChannelKey: holder.key,
      threadType: holder.thread?.type ?? null,
      name: holder.name,
      highWaterMessageId: mark,
      createdAt: clock.now(),
    };
    const jsonPath = folder.pathFor(dayId, runId, folderName, id, '.json');
    const json = await folder.write(jsonPath, `${JSON.stringify(transcript, null, 2)}\n`);
    const jsonId = store.insertFile({ ...common, kind: holder.threadId ? 'thread_transcript_json' : 'transcript_json', path: jsonPath, downloadName: `${base}.json`, ...json });
    const htmlPath = folder.pathFor(dayId, runId, folderName, id, '.html');
    const html = await folder.write(htmlPath, renderTranscriptHtml(transcript));
    store.insertFile({ ...common, kind: holder.threadId ? 'thread_transcript_html' : 'transcript_html', path: htmlPath, downloadName: `${base}.html`, ...html, highWaterMessageId: null });
    return jsonId;
  }

  /** One attachment's download in this run: re-resolved now (CDN URLs expire), capped, hashed. */
  async function fetchAttachment(
    runId: number,
    dayId: number,
    holder: Pick<Holder, 'channelId' | 'threadId' | 'eventId' | 'key' | 'thread'>,
    a: { attachmentId: string; messageId: string; filename: string; declaredBytes: number },
    cap: number,
  ): Promise<{ state: 'saved'; fileId: number } | { state: 'skipped'; reason: 'over_cap' | 'download_failed' | 'message_deleted' }> {
    if (a.declaredBytes > cap) return { state: 'skipped', reason: 'over_cap' };
    const resolved = await gateway().resolveAttachment(holder.threadId ?? holder.channelId, a.messageId, a.attachmentId);
    if ('error' in resolved) return { state: 'skipped', reason: resolved.error === 'message_deleted' ? 'message_deleted' : 'download_failed' };
    const path = folder.pathFor(dayId, runId, 'attachments', a.attachmentId);
    // Never more than declared (itself within the cap): a body longer than its attachment is not that attachment.
    const result = await fetcher(resolved.url, { maxBytes: Math.min(a.declaredBytes, cap), destination: await folder.prepare(path) });
    if (!result.ok) return { state: 'skipped', reason: 'download_failed' };
    const fileId = store.insertFile({
      dayId,
      runId,
      kind: 'attachment',
      eventId: holder.eventId,
      channelId: holder.channelId,
      threadId: holder.threadId,
      parentChannelId: holder.threadId ? holder.channelId : null,
      blueprintChannelKey: holder.key,
      threadType: holder.thread?.type ?? null,
      attachmentId: a.attachmentId,
      name: a.filename,
      path,
      downloadName: safeDownloadName(a.filename, 'attachment'),
      sha256: result.sha256,
      bytes: result.bytes,
      createdAt: clock.now(),
    });
    return { state: 'saved', fileId };
  }

  /** The current attachment rows of the day: those of current JSON transcripts. */
  function currentAttachments(dayId: number): { row: AttachmentRow; transcript: FileRow }[] {
    const transcripts = store.currentFiles(dayId).filter((f) => f.kind === 'transcript_json' || f.kind === 'thread_transcript_json');
    const byId = new Map(transcripts.map((t) => [t.id, t]));
    return store.attachmentsOf(transcripts.map((t) => t.id)).map((row) => ({ row, transcript: byId.get(row.exportFileId)! }));
  }

  /** Records a transcript's attachments: reusing saved files, keeping discards, downloading the rest. */
  async function saveAttachments(runId: number, dayId: number, jsonId: number, holder: Holder, messages: HistoryMessage[], prior: Map<string, AttachmentRow>): Promise<void> {
    const cap = opts.settings.get().attachmentCapBytes;
    for (const m of messages) {
      for (const a of m.attachments) {
        const base = { exportFileId: jsonId, attachmentId: a.id, messageId: m.id, channelId: holder.threadId ?? holder.channelId, filename: a.filename, declaredBytes: a.size };
        const before = prior.get(a.id);
        if (before?.state === 'discarded') {
          store.insertAttachment({ ...base, state: 'discarded', reason: before.reason, discardedBy: before.discardedBy, discardedAt: before.discardedAt });
          continue;
        }
        if (before?.state === 'saved' && before.fileId !== null) {
          const file = store.file(before.fileId);
          if (file && (await folder.check(file.path, file.sha256)) === 'ok') {
            store.insertAttachment({ ...base, state: 'saved', fileId: file.id });
            continue;
          }
        }
        const outcome = await fetchAttachment(runId, dayId, holder, { attachmentId: a.id, messageId: m.id, filename: a.filename, declaredBytes: a.size }, cap);
        store.insertAttachment(outcome.state === 'saved' ? { ...base, state: 'saved', fileId: outcome.fileId } : { ...base, state: 'skipped', reason: outcome.reason });
      }
    }
  }

  function schedulePurge(dayId: number): number {
    const graceUntil = plan(dayId).day.graceUntil ?? clock.now();
    return jobs.schedule({ kind: 'purge', dayId, dueAt: Math.max(clock.now(), graceUntil) });
  }

  // ---- the jobs

  async function lock(ctx: JobContext): Promise<void> {
    const dayId = ctx.dayId!;
    const discord = gateway();
    const targets = await provisioning.lockTargets(dayId);
    for (const c of targets.channels) {
      const state = await discord.getChannel(c.discordChannelId);
      if (!state) {
        provisioning.markChannel(c.rowId, 'missing');
        ctx.log('warn', 'A channel is gone from Discord: nothing to lock there.', { channelId: c.discordChannelId });
        continue;
      }
      // Already locked: never written again, whatever the plan says now (the relock case, #9).
      if (c.lockedAt !== null || isLocked(state.overwrites, targets.guild.botUserId)) {
        if (c.lockedAt === null) provisioning.markChannel(c.rowId, 'locked');
        continue;
      }
      try {
        await discord.setOverwrites(state.id, c.locked);
      } catch (err) {
        throw new Error(`lock refused on #${c.name}: ${errorText(err)}`, { cause: err });
      }
      provisioning.markChannel(c.rowId, 'locked');
      ctx.log('info', 'Locked a channel.', { channelId: state.id });
    }
    eventDays.recordApplied(dayId, targets.planRevision);
    if (targets.panel) {
      await discord.editMessage(targets.panel.channelId, targets.panel.messageId, { content: 'This day is closed.' }).catch((err: unknown) => {
        ctx.log('warn', 'Couldn’t update the head-judges panel.', { error: errorText(err) });
      });
    }
    jobs.schedule({ kind: 'export', dayId, dueAt: clock.now() });
  }

  async function exportDay(ctx: JobContext, kind: 'export' | 'reexport'): Promise<void> {
    const dayId = ctx.dayId!;
    await cleanup(dayId);
    const runId = store.startRun({ dayId, kind, jobId: ctx.jobId, now: clock.now() });
    try {
      const discord = gateway();
      const b = requireBinding();
      const contentIntent = ((await discord.getApplication()).flags & MESSAGE_CONTENT_FLAGS) !== 0;
      if (!contentIntent) ctx.log('warn', 'The bot lacks the Message Content intent: transcripts hold little but bot messages. The purge waits for a re-export with it on.');
      const guild = await discord.getGuild(b.guildId);
      if (!guild) throw new Error('bot_not_in_guild');

      // Without Manage Threads, private threads the bot isn't in are left out silently (S4): check before listing.
      const live: { row: ReturnType<ProvisioningService['closeoutChannels']>[number]; name: string }[] = [];
      for (const row of provisioning.closeoutChannels(dayId).filter((r) => r.state === 'present')) {
        const state = await discord.getChannel(row.discordChannelId);
        if (!state) {
          provisioning.markChannel(row.rowId, 'missing');
          ctx.log('warn', 'A channel is gone from Discord: no transcript.', { channelId: row.discordChannelId });
          continue;
        }
        const bits = effectivePermissions({
          guildId: guild.id,
          guildOwnerId: guild.ownerId,
          roles: guild.roles,
          member: { userId: guild.botUserId, roleIds: guild.botRoleIds },
          channel: { overwrites: state.overwrites },
        });
        const missing = (['ViewChannel', 'ReadMessageHistory', 'ManageThreads'] as const).filter((p) => !can(bits, p));
        if (missing.length) throw new Error(`missing_channel_permissions: #${state.name}: ${missing.join(', ')}`);
        live.push({ row, name: state.name });
      }

      const prior = new Map(currentAttachments(dayId).map(({ row }) => [row.attachmentId, row]));
      for (const { row, name } of live) {
        const holder: Holder = { channelId: row.discordChannelId, threadId: null, name, eventId: row.eventId, key: row.key, thread: null };
        const messages = await readAll(discord, row.discordChannelId);
        if (messages === null) {
          provisioning.markChannel(row.rowId, 'missing');
          ctx.log('warn', 'A channel is gone from Discord: no transcript.', { channelId: row.discordChannelId });
          continue;
        }
        const jsonId = await writeTranscript(runId, dayId, holder, messages, contentIntent);
        await saveAttachments(runId, dayId, jsonId, holder, messages, prior);
        ctx.log('info', `Exported a channel: ${messages.length} messages.`, { channelId: row.discordChannelId, messages: messages.length });
        for (const thread of await discord.listThreads(guild.id, row.discordChannelId)) {
          const threadMessages = await readAll(discord, thread.id);
          if (threadMessages === null) {
            ctx.log('warn', 'A thread was deleted while it was exported: no transcript.', { channelId: row.discordChannelId, threadId: thread.id });
            continue;
          }
          const threadHolder: Holder = { ...holder, threadId: thread.id, name: thread.name, thread: { type: thread.type, archived: thread.archived } };
          const threadJson = await writeTranscript(runId, dayId, threadHolder, threadMessages, contentIntent);
          await saveAttachments(runId, dayId, threadJson, threadHolder, threadMessages, prior);
          ctx.log('info', `Exported a thread: ${threadMessages.length} messages.`, { channelId: row.discordChannelId, threadId: thread.id, messages: threadMessages.length });
        }
      }
      for (const ev of plan(dayId).events) await writeCsvs(runId, dayId, ev);
      store.succeedRun(runId, clock.now(), contentIntent);
    } catch (err) {
      store.failRun(runId, clock.now());
      throw err;
    }
    store.setRefusal(dayId, null, clock.now());
    if (kind === 'export' && plan(dayId).day.state === 'closing') {
      const graceUntil = clock.now() + graceMs;
      eventDays.markClosed(dayId, graceUntil);
      jobs.schedule({ kind: 'purge', dayId, dueAt: graceUntil });
      logger.info('Day closed.', { dayId, graceUntil });
    } else if (plan(dayId).day.state === 'closed') {
      schedulePurge(dayId);
    }
  }

  async function retryAttachmentsJob(ctx: JobContext): Promise<void> {
    const dayId = ctx.dayId!;
    await cleanup(dayId);
    const runId = store.startRun({ dayId, kind: 'attachments_retry', jobId: ctx.jobId, now: clock.now() });
    try {
      const cap = opts.settings.get().attachmentCapBytes;
      const updates: { id: number; patch: Parameters<typeof store.updateAttachment>[1] }[] = [];
      for (const { row, transcript } of currentAttachments(dayId).filter((a) => a.row.state === 'skipped')) {
        const holder = {
          channelId: transcript.channelId!,
          threadId: transcript.threadId,
          eventId: transcript.eventId,
          key: transcript.blueprintChannelKey ?? '',
          thread: transcript.threadType ? { type: transcript.threadType, archived: false } : null,
        };
        const outcome = await fetchAttachment(runId, dayId, holder, row, cap);
        updates.push({ id: row.id, patch: outcome.state === 'saved' ? { state: 'saved', reason: null, fileId: outcome.fileId } : { state: 'skipped', reason: outcome.reason } });
      }
      store.transaction(() => {
        for (const u of updates) store.updateAttachment(u.id, u.patch);
        store.succeedRun(runId, clock.now(), null);
      });
      ctx.log('info', `Retried ${updates.length} attachments: ${updates.filter((u) => u.patch.state === 'saved').length} saved.`);
    } catch (err) {
      store.failRun(runId, clock.now());
      throw err;
    }
    if (!currentAttachments(dayId).some((a) => a.row.state === 'skipped')) {
      store.setRefusal(dayId, null, clock.now());
      schedulePurge(dayId);
    }
  }

  /** The newest message of a channel or thread that isn't one of Genie's alert posts; the mark when none is newer. */
  async function latestOther(discord: DiscordGateway, id: string, mark: string | null, alerts: Set<string>): Promise<string | null | 'gone'> {
    const latest = await discord.getLatestMessageId(id);
    if (latest === 'gone' || latest === null || !isNewer(latest, mark) || !alerts.has(latest)) return latest;
    let before: string | undefined;
    for (;;) {
      const page = await discord.readHistory(id, before);
      if (!page?.length) return mark;
      for (const m of page) {
        if (!isNewer(m.id, mark)) return mark;
        if (!alerts.has(m.id)) return m.id;
      }
      before = page.at(-1)!.id;
    }
  }

  async function threadsOf(discord: DiscordGateway, guildId: string, channelId: string) {
    if (!(await discord.getChannel(channelId))) return [];
    return (await discord.listThreads(guildId, channelId)).map((t) => ({ channelId, threadId: t.id, name: t.name }));
  }

  async function purgeJob(ctx: JobContext): Promise<void> {
    const dayId = ctx.dayId!;
    const day = plan(dayId).day;
    if (day.state === 'purged') {
      ctx.log('info', 'The day is already purged.');
      return;
    }
    if (day.state !== 'closed') throw new Error('day_not_closed');
    const discord = gateway();
    const b = requireBinding();
    const alerts = new Set(JSON.parse(store.closeout(dayId).alertMessageIds) as string[]);
    const refuse = async (reasons: RefusalReason[]): Promise<never> => {
      store.setRefusal(dayId, reasons, clock.now());
      logger.warn('Purge refused.', { dayId, reasons: reasons.length });
      await alert(dayId, `the purge was refused (${reasons.length} reasons)`);
      throw new PurgeRefused(`purge_refused: ${reasons.length} reasons`);
    };

    const current = store.currentFiles(dayId);
    const present = provisioning.closeoutChannels(dayId).filter((r) => r.state === 'present');
    const transcriptRows = current.filter((f) => f.kind === 'transcript_json' || f.kind === 'thread_transcript_json');
    const transcripts: PurgeFacts['transcripts'] = [];
    for (const f of transcriptRows) {
      transcripts.push({
        channelId: f.channelId!,
        threadId: f.threadId,
        name: f.name,
        mark: f.highWaterMessageId,
        contentIntent: store.contentIntentOf(f.runId),
        latest: await latestOther(discord, f.threadId ?? f.channelId!, f.highWaterMessageId, alerts),
      });
    }
    const threadsNow: PurgeFacts['threadsNow'] = [];
    for (const row of present) threadsNow.push(...(await threadsOf(discord, b.guildId, row.discordChannelId)));
    const files: PurgeFacts['files'] = [];
    for (const f of current) files.push({ fileId: f.id, name: f.name, check: await folder.check(f.path, f.sha256) });
    const decision = purgeDecision({
      exportSucceeded: store.hasSucceededExport(dayId),
      files,
      transcripts,
      threadsNow,
      presentChannels: present.map((r) => ({ channelId: r.discordChannelId, name: r.key })),
      skippedAttachments: currentAttachments(dayId).filter((a) => a.row.state === 'skipped').length,
    });
    if (!decision.allowed) await refuse(decision.reasons);

    for (const row of present) {
      // Right before this channel goes: nothing new in it or its threads since the gate.
      const mine: PurgeFacts['transcripts'] = [];
      for (const t of transcripts.filter((x) => x.channelId === row.discordChannelId)) {
        mine.push({ ...t, latest: await latestOther(discord, t.threadId ?? t.channelId, t.mark, alerts) });
      }
      const recheck = purgeDecision({
        exportSucceeded: true,
        files: [],
        transcripts: mine,
        threadsNow: await threadsOf(discord, b.guildId, row.discordChannelId),
        presentChannels: [],
        skippedAttachments: 0,
      });
      if (!recheck.allowed) await refuse(recheck.reasons);
      await discord.deleteChannel(row.discordChannelId, 'purge a closed day after its export');
      provisioning.markChannel(row.rowId, 'deleted');
      ctx.log('info', 'Deleted a channel.', { channelId: row.discordChannelId });
    }
    if (day.categoryId) {
      const left = (await discord.listChannels(b.guildId)).filter((c) => c.parentId === day.categoryId);
      if (left.length) ctx.log('warn', `Left the day’s category: it still holds ${left.length} channel(s) Genie didn’t create.`, { channelIds: left.map((c) => c.id) });
      else await discord.deleteChannel(day.categoryId, 'purge a closed day after its export');
    }
    eventDays.markPurged(dayId);
    store.setRefusal(dayId, null, clock.now());
    logger.info('Day purged.', { dayId });
  }

  async function retentionSweep(ctx: JobContext): Promise<void> {
    jobs.schedule({ kind: 'retention_sweep', dayId: null, dueAt: clock.now() + DAY_MS });
    const s = opts.settings.get();
    for (const day of eventDays.closedDays().filter((d) => d.state === 'purged')) {
      const row = store.closeout(day.id);
      const due = retentionDue({ closedAt: day.closedAt, transcriptsSweptAt: row.transcriptsSweptAt, penaltiesSweptAt: row.penaltiesSweptAt }, s, clock.now());
      if (due.transcripts) {
        const gone = store.deleteFiles(day.id, 'transcripts');
        for (const f of gone) await folder.remove(f.path);
        store.setSwept(day.id, 'transcripts', clock.now());
        ctx.log('info', `Retention: deleted ${gone.length} transcript and attachment files.`, { dayId: day.id, files: gone.length });
      }
      if (due.penalties) {
        const gone = store.deleteFiles(day.id, 'csvs');
        for (const f of gone) await folder.remove(f.path);
        const count = penalties.deleteForDay(day.id);
        store.setSwept(day.id, 'penalties', clock.now());
        ctx.log('info', `Retention: deleted ${count} penalties and ${gone.length} CSV files.`, { dayId: day.id, penalties: count, files: gone.length });
      }
      if (due.transcripts || due.penalties) await folder.prune(day.id);
    }
  }

  // ---- corrections (§6.4: organizers only after close, each re-exporting the event's CSVs)

  async function correctionRun(dayId: number, events: EventView[]): Promise<Map<number, number | null>> {
    await cleanup(dayId);
    const runId = store.startRun({ dayId, kind: 'correction', jobId: null, eventId: events.length === 1 ? events[0]!.id : null, now: clock.now() });
    const written = new Map<number, number | null>();
    try {
      for (const ev of events) written.set(ev.id, await writeCsvs(runId, dayId, ev));
      store.succeedRun(runId, clock.now(), null);
    } catch (err) {
      store.failRun(runId, clock.now());
      logger.error('A correction’s CSV could not be written.', { dayId, err: errorText(err) });
      await recordFailure(dayId, 'correction', err);
      throw new ServiceError(500, 'correction_export_failed', 'The change was saved, but its CSV couldn’t be written. Use Rewrite CSVs on the Exports page.');
    }
    clearFailure(dayId, 'correction');
    return written;
  }

  function requireNotSwept(dayId: number): void {
    if (store.closeout(dayId).penaltiesSweptAt !== null) throw notFound('penalty');
  }

  function requireClosed(dayId: number): void {
    if (plan(dayId).day.state !== 'closed') throw new ServiceError(409, 'day_not_closed', 'Only a closed day can do this.');
  }

  function requireIdle(dayId: number): void {
    if (jobs.active(dayId).some((j) => IN_FLIGHT.includes(j.kind) || (j.kind === 'purge' && j.state === 'running'))) {
      throw new ServiceError(409, 'closeout_in_progress', 'A close-out job is running for this day. Wait for it to finish.');
    }
  }

  // ---- what the website shows

  function resourceOf(file: FileRow, dayPurged: boolean): Resource {
    if (file.kind === 'penalties_csv' || file.kind === 'penalties_voided_csv') return { kind: 'export_file', file: { kind: 'csv', eventId: file.eventId! }, dayPurged };
    return {
      kind: 'export_file',
      file: { kind: 'transcript', blueprintKey: file.blueprintChannelKey ?? '', eventId: file.eventId, privateThread: file.threadType === 'private' },
      dayPurged,
    };
  }

  const fileView = (f: FileRow) => ({
    id: f.id,
    kind: f.kind,
    attachmentId: f.attachmentId,
    name: f.name,
    downloadName: f.downloadName,
    bytes: f.bytes,
    sha256: f.sha256,
    createdAt: f.createdAt,
    supersededBy: f.supersededBy,
  });

  function csvBlocked(dayId: number) {
    const written = new Set(store.currentFiles(dayId).filter((f) => f.kind === 'penalties_csv').map((f) => f.eventId));
    return plan(dayId)
      .events.filter((e) => !written.has(e.id) && !(e.tournamentId && TOURNAMENT_ID.test(e.tournamentId)))
      .map((e) => ({ eventId: e.id, name: e.name }));
  }

  return {
    register(): void {
      jobs.register('lock', job('lock', lock), { retryOnBoot: true });
      jobs.register('export', job('export', (ctx) => exportDay(ctx, 'export')), { retryOnBoot: true });
      jobs.register('reexport', job('reexport', (ctx) => exportDay(ctx, 'reexport')), { retryOnBoot: true });
      jobs.register('attachments_retry', job('attachments_retry', retryAttachmentsJob), { retryOnBoot: true });
      jobs.register('purge', job('purge', purgeJob), { retryOnBoot: true });
      jobs.register('retention_sweep', retentionSweep, { retryOnBoot: true });
    },

    /** Before `jobs.recover()`: runs cut short by a stop become failed; the daily sweep is scheduled. */
    recoverOnBoot(): void {
      const failed = store.failRunning(clock.now());
      if (failed) logger.warn('Boot: export runs cut short by the stop were marked failed.', { runs: failed });
      jobs.schedule({ kind: 'retention_sweep', dayId: null, dueAt: clock.now() });
    },

    preflight(dayId: number): ClosePreflight {
      plan(dayId);
      return {
        recentPenalties: penalties.recentPenalties(dayId),
        csvBlocked: csvBlocked(dayId),
        channels: provisioning.closeoutChannels(dayId).filter((c) => c.state === 'present').length,
      };
    },

    /** Close the day (§6.5 step 1), or resume a close whose lock or export failed. */
    async close(dayId: number, by: string): Promise<{ jobId: number }> {
      const state = plan(dayId).day.state;
      if (state === 'draft') throw new ServiceError(409, 'day_not_open', 'Only an open day can be closed.');
      if (state === 'closed' || state === 'purged') throw new ServiceError(409, 'day_closed', 'This day is already closed.');
      if (state === 'closing') {
        const latest = jobs.latestOf(dayId, ['lock', 'export']);
        if (latest && (latest.state === 'queued' || latest.state === 'running')) throw new ServiceError(409, 'close_in_progress', 'The day is being closed.');
        const jobId = jobs.enqueue({ kind: 'lock', dayId });
        logger.info('Close resumed.', { dayId, jobId, by });
        return { jobId };
      }
      const b = requireBinding();
      let guild;
      try {
        guild = await gateway().getGuild(b.guildId);
      } catch (err) {
        if (err instanceof DiscordUnavailableError || err instanceof DiscordAuthError) throw unreachable();
        throw err;
      }
      if (!guild) throw unreachable();
      const missing = missingPermissions(guild.botPermissions);
      if (missing.length) throw new ServiceError(422, 'close_preconditions_failed', 'The bot can’t lock the channels yet.', { problems: [{ code: 'missing_permissions', permissions: missing }] });
      const jobId = eventDays.markClosing(dayId, by, () => jobs.enqueue({ kind: 'lock', dayId }));
      logger.info('Day closing.', { dayId, jobId, by });
      return { jobId };
    },

    /** "Delete now": the grace period ends now. */
    purgeNow(dayId: number): { jobId: number } {
      requireClosed(dayId);
      eventDays.setGraceUntil(dayId, clock.now());
      const jobId = jobs.schedule({ kind: 'purge', dayId, dueAt: clock.now() });
      logger.info('Delete now.', { dayId, jobId });
      return { jobId };
    },

    reexport(dayId: number): { jobId: number } {
      requireClosed(dayId);
      requireIdle(dayId);
      return { jobId: jobs.enqueue({ kind: 'reexport', dayId }) };
    },

    retryAttachments(dayId: number): { jobId: number } {
      requireClosed(dayId);
      requireIdle(dayId);
      if (!currentAttachments(dayId).some((a) => a.row.state === 'skipped')) throw new ServiceError(409, 'nothing_skipped', 'No attachment is waiting to be retried.');
      return { jobId: jobs.enqueue({ kind: 'attachments_retry', dayId }) };
    },

    /** Confirmed discards (§6.5): logged with who, when and which; the purge proceeds once none is skipped. */
    discard(dayId: number, attachmentIds: number[], by: string): { discarded: number; purgeJobId: number | null } {
      requireClosed(dayId);
      requireIdle(dayId);
      const skipped = new Set(currentAttachments(dayId).filter((a) => a.row.state === 'skipped').map((a) => a.row.id));
      const wrong = attachmentIds.filter((id) => !skipped.has(id));
      if (wrong.length) throw new ServiceError(422, 'not_skipped', 'Only skipped attachments can be discarded.', { attachmentIds: wrong });
      const at = clock.now();
      store.transaction(() => {
        for (const id of attachmentIds) store.updateAttachment(id, { state: 'discarded', discardedBy: by, discardedAt: at });
      });
      logger.info('attachments_discarded', { dayId, by, at, count: attachmentIds.length, attachmentIds });
      const left = currentAttachments(dayId).some((a) => a.row.state === 'skipped');
      return { discarded: attachmentIds.length, purgeJobId: left ? null : schedulePurge(dayId) };
    },

    /** An organizer's edit or void after close: the penalty changes, then the event's CSVs are written again. */
    async correctPenalty(
      dayId: number,
      penaltyId: number,
      change: { kind: 'edit'; patch: PenaltyPatch } | { kind: 'void'; reason: string },
      who: { expectedRevision: number; by: string; organizer: boolean },
    ): Promise<{ penalty: PenaltyView; exportFileId: number | null }> {
      const state = plan(dayId).day.state;
      if (state === 'closing') throw new ServiceError(409, 'day_closing', 'The day is closing: wait for its export.');
      if (state !== 'closed' && state !== 'purged') throw new ServiceError(409, 'day_not_open', 'Penalties change only while the day is open.');
      if (!who.organizer) throw new ServiceError(403, 'closed_organizer_only', 'After close, only organizers can correct penalties.');
      requireNotSwept(dayId);
      const result =
        change.kind === 'edit'
          ? await penalties.edit(dayId, penaltyId, change.patch, { expectedRevision: who.expectedRevision, by: who.by, correction: true })
          : await penalties.voidPenalty(dayId, penaltyId, { reason: change.reason, expectedRevision: who.expectedRevision, by: who.by, correction: true });
      const ev = plan(dayId).events.find((e) => e.id === result.penalty.eventId)!;
      const written = await correctionRun(dayId, [ev]);
      return { penalty: result.penalty, exportFileId: written.get(ev.id) ?? null };
    },

    /** The one plan change after close (§6.6): an event's Tournament ID, which lets its CSVs be written. */
    async setTournamentId(dayId: number, eventId: number, tournamentId: string | null): Promise<EventView> {
      const ev = eventDays.patchEvent(dayId, eventId, { tournamentId });
      if (store.closeout(dayId).penaltiesSweptAt === null) await correctionRun(dayId, [ev]);
      return ev;
    },

    /** Rewrite CSVs: every event's, as a correction (after a failed correction, say). */
    async rewriteCsvs(dayId: number): Promise<{ written: number }> {
      const state = plan(dayId).day.state;
      if (state !== 'closed' && state !== 'purged') throw new ServiceError(409, 'day_not_closed', 'Only a closed day’s CSVs can be rewritten.');
      requireNotSwept(dayId);
      const written = await correctionRun(dayId, plan(dayId).events);
      return { written: [...written.values()].filter((id) => id !== null).length };
    },

    settings(): CloseOutSettingsView {
      const s = opts.settings.get();
      return {
        transcriptRetentionDays: s.transcriptRetentionDays,
        penaltyRetentionDays: s.penaltyRetentionDays,
        attachmentCapMb: Math.round(s.attachmentCapBytes / MIB),
        purgeGraceHours: Math.round(graceMs / HOUR_MS),
      };
    },
    putSettings(s: CloseOutSettings): CloseOutSettingsView {
      if (s.transcriptRetentionDays * DAY_MS <= graceMs) {
        throw new ServiceError(422, 'retention_not_longer_than_grace', 'Keep transcripts longer than the grace period, or they could be swept before the channels are.', {
          purgeGraceHours: Math.round(graceMs / HOUR_MS),
        });
      }
      opts.settings.put({ transcriptRetentionDays: s.transcriptRetentionDays, penaltyRetentionDays: s.penaltyRetentionDays, attachmentCapBytes: s.attachmentCapMb * MIB }, clock.now());
      return this.settings();
    },

    /** The day's files a caller may see (`principal` null: an organizer), with what organizers act on. */
    exportsView(dayId: number, principal: Principal | null, access?: AccessPlan) {
      const p = plan(dayId);
      const organizer = principal === null || isOrganizer(principal.grant);
      const purged = p.day.state === 'purged';
      const visible = (f: FileRow) => organizer || canSee(principal, resourceOf(f, purged), access);
      const all = store.allFiles(dayId).filter(visible);
      const current = store.currentFiles(dayId);
      const currentIds = new Set(current.map((f) => f.id));
      const jsonKinds = ['transcript_json', 'thread_transcript_json'];
      const htmlKind = (kind: string) => kind.replace('json', 'html');
      const attachmentRows = store.attachmentsOf(all.filter((f) => jsonKinds.includes(f.kind)).map((f) => f.id));
      const transcriptView = (json: FileRow) => {
        const html = all.find((f) => f.runId === json.runId && f.kind === htmlKind(json.kind) && f.channelId === json.channelId && f.threadId === json.threadId)!;
        const older = all.filter((f) => f.kind === json.kind && f.id !== json.id && f.channelId === json.channelId && f.threadId === json.threadId);
        return {
          channelId: json.channelId!,
          threadId: json.threadId,
          name: json.name,
          eventId: json.eventId,
          highWaterMessageId: json.highWaterMessageId,
          json: fileView(json),
          html: fileView(html),
          supersededVersions: older.map((o) => ({
            json: fileView(o),
            html: fileView(all.find((f) => f.runId === o.runId && f.kind === htmlKind(o.kind) && f.channelId === o.channelId && f.threadId === o.threadId)!),
          })),
          attachments: attachmentRows
            .filter((a) => a.exportFileId === json.id)
            .map((a) => ({ id: a.id, filename: a.filename, declaredBytes: a.declaredBytes, state: a.state, reason: a.reason, fileId: a.fileId, discardedAt: a.discardedAt })),
        };
      };
      const currentJson = all.filter((f) => jsonKinds.includes(f.kind) && currentIds.has(f.id));
      const closeout = store.closeout(dayId);
      const latestJob = jobs.latestOf(dayId, ['lock', 'export', 'reexport', 'attachments_retry', 'purge']);
      return {
        day: { id: p.day.id, title: p.day.title, date: p.day.date, state: p.day.state, closedAt: p.day.closedAt, graceUntil: p.day.graceUntil, purgedAt: p.day.purgedAt },
        csvs: p.events
          .map((e) => ({
            eventId: e.id,
            eventName: e.name,
            files: all
              .filter((f) => f.eventId === e.id && (f.kind === 'penalties_csv' || f.kind === 'penalties_voided_csv'))
              .sort((a, b) => Number(currentIds.has(b.id)) - Number(currentIds.has(a.id)) || b.id - a.id)
              .map(fileView),
          }))
          .filter((e) => e.files.length),
        transcripts: currentJson
          .filter((f) => f.kind === 'transcript_json')
          .map((f) => ({ ...transcriptView(f), threads: currentJson.filter((t) => t.kind === 'thread_transcript_json' && t.channelId === f.channelId).map(transcriptView) })),
        swept: { transcriptsAt: closeout.transcriptsSweptAt, penaltiesAt: closeout.penaltiesSweptAt },
        ...(organizer
          ? {
              organizer: {
                refusal: closeout.purgeRefusal ? { at: closeout.purgeRefusedAt!, reasons: JSON.parse(closeout.purgeRefusal) as RefusalReason[] } : null,
                csvBlocked: csvBlocked(dayId),
                skipped: currentAttachments(dayId)
                  .filter((a) => a.row.state === 'skipped')
                  .map((a) => ({ id: a.row.id, filename: a.row.filename, reason: a.row.reason!, transcriptName: a.transcript.name })),
                latestJob: latestJob ? { id: latestJob.id, kind: latestJob.kind, state: latestJob.state, error: latestJob.error } : null,
                contentIntentMissing: current.some((f) => jsonKinds.includes(f.kind) && !store.contentIntentOf(f.runId)),
              },
            }
          : {}),
      };
    },

    /** A file a caller may download, with its path on disk; `null` when it doesn't exist (or left the folder). */
    download(fileId: number): { file: FileRow; path: string | null; resource: Resource; dayId: number } | null {
      const file = store.file(fileId);
      if (!file || store.run(file.runId).state !== 'succeeded') return null;
      const path = folder.inside(file.path);
      if (!path) logger.error('An export file’s stored path leaves the exports folder.', { fileId });
      return { file, path, resource: resourceOf(file, plan(file.dayId).day.state === 'purged'), dayId: file.dayId };
    },

    alarms(): CloseoutAlarm[] {
      const out: CloseoutAlarm[] = [];
      for (const row of store.allCloseouts()) {
        const title = plan(row.dayId).day.title;
        if (row.lastFailure) {
          const failure = JSON.parse(row.lastFailure) as { kind: FailureKind; at: number };
          out.push({ kind: 'closeout_failed', dayId: row.dayId, title, jobKind: failure.kind, since: failure.at });
        }
        if (row.purgeRefusal) out.push({ kind: 'purge_refused', dayId: row.dayId, title, reasons: (JSON.parse(row.purgeRefusal) as unknown[]).length, since: row.purgeRefusedAt! });
      }
      return out;
    },
  };
}

export type CloseoutService = ReturnType<typeof createCloseoutService>;
