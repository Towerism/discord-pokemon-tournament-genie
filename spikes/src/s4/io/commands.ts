import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ChannelType, OverwriteType } from 'discord.js';
import { ExitError, OUT_DIR, guarded, log, runId as newRun, warn, whoAmI } from '../../io/session.js';
import { Api, fromBits, ok, toBits } from '../../io/rest.js';
import { canSnapshot, createLedger, createTracked, markRestored, readLedgers, recordSnapshot, type LedgerHandle } from '../../shared/ledger.js';
import { applyCleanup, planCleanup } from '../../shared/cleanup.js';
import { CleanupAdapter, genieRoleId } from '../../s3/io/adapters.js';
import type { Config } from '../../shared/config.js';
import {
  ATTACHMENT_SIZES,
  cdnExpiry,
  contentProbeRow,
  intentState,
  pageStats,
  planSeed,
  recordUpload,
  threadListingReport,
  type Listing,
  type ListingName,
  type MessageKind,
  type SeededThread,
  type ThreadKind,
  type UploadRecord,
} from '../analysis.js';

type Seed = {
  runId: string;
  guildId: string;
  channels: string[];
  threadParent: string;
  threads: SeededThread[];
  attachments: (UploadRecord & { channelId?: string; messageId?: string; attachmentId?: string; url?: string; expiresAt?: string | null })[];
  probe: { kind: MessageKind; channelId: string; messageId: string }[];
  seedMs: number;
};

const seedFile = (runId: string) => join(OUT_DIR, `s4-seed-${runId}.json`);

async function latestSeed(): Promise<Seed> {
  const ledgers = (await readLedgers(OUT_DIR)).filter((l) => l.kept).map((l) => l.runId).sort().reverse();
  for (const id of ledgers) {
    const raw = await readFile(seedFile(id), 'utf8').catch(() => undefined);
    if (raw) return JSON.parse(raw) as Seed;
  }
  throw new ExitError(1, 'no kept S4 seed found; run `pnpm spike s4 seed` first');
}

/** FR-26: a busy day across channels and six threads, with attachments at the upload cap's edges. */
export async function s4Seed(c: Config, opts: { channels: number; messages: number; keep: boolean }) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const arranger = new Api(c.GENIE_SPIKE_ARRANGER_TOKEN!);
  const authors = [arranger, new Api(c.GENIE_SPIKE_PROBE_A_TOKEN!), new Api(c.GENIE_SPIKE_PROBE_B_TOKEN!)];
  await guarded(arranger, guildId);
  const [genie, probeA, probeB] = await Promise.all(
    [c.GENIE_SPIKE_GENIE_TOKEN!, c.GENIE_SPIKE_PROBE_A_TOKEN!, c.GENIE_SPIKE_PROBE_B_TOKEN!].map((t) => whoAmI(new Api(t))),
  );
  const ledger = await createLedger(OUT_DIR, { runId: newRun(), guildId, kept: opts.keep });
  const prefix = `spike-${ledger.data.runId}`;
  const started = performance.now();
  try {
    const allow = toBits(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'SendMessagesInThreads', 'EmbedLinks']);
    const overwrites = [
      { id: guildId, type: OverwriteType.Role, allow: '0', deny: toBits(['ViewChannel']) },
      ...[genie!.id, probeA!.id, probeB!.id].map((id) => ({ id, type: OverwriteType.Member, allow, deny: '0' })),
    ];
    const create = (name: string, type: ChannelType, parent?: string) =>
      createTracked(ledger, { kind: type === ChannelType.GuildCategory ? 'category' : 'channel', name }, async () =>
        (await arranger.must<{ id: string }>('post', `/guilds/${guildId}/channels`, {
          body: { name, type, permission_overwrites: overwrites, ...(parent ? { parent_id: parent } : {}) },
        })).id,
      );
    const category = await create(`${prefix}-s4`, ChannelType.GuildCategory);
    const channels: string[] = [];
    for (let i = 0; i < opts.channels; i++) channels.push(await create(`${prefix}-s4-${i + 1}`, ChannelType.GuildText, category));

    const plan = planSeed(opts);
    // One sequential loop per author (NFR-5), round-robin over channels.
    const jobs = plan.perChannel.flatMap((count, ch) => Array.from({ length: count }, (_, i) => ({ ch: channels[ch]!, i })));
    await Promise.all(
      authors.map(async (api, a) => {
        for (const [n, job] of jobs.entries()) {
          if (n % authors.length !== a) continue;
          await api.must('post', `/channels/${job.ch}/messages`, { body: { content: `S4 busy-day message ${n + 1} by ${plan.authors[a]}` } });
        }
      }),
    );

    const parent = channels[0]!;
    const threads: SeededThread[] = [];
    for (const t of plan.threads) {
      const isPrivate = t.kind.startsWith('private');
      const name = `${prefix}-t${threads.length + 1}`;
      const id = await createTracked(ledger, { kind: 'thread', name }, async () =>
        (await arranger.must<{ id: string }>('post', `/channels/${parent}/threads`, {
          body: { name, type: isPrivate ? ChannelType.PrivateThread : ChannelType.PublicThread, invitable: false },
        })).id,
      );
      if (isPrivate) {
        for (const u of [probeA!.id, probeB!.id]) await arranger.must('put', `/channels/${id}/thread-members/${u}`);
        if (t.kind !== 'private-active-genie-not-member') await arranger.must('put', `/channels/${id}/thread-members/${genie!.id}`);
      }
      for (let i = 0; i < t.messages; i++) {
        await authors[i % authors.length]!.must('post', `/channels/${id}/messages`, { body: { content: `thread message ${i + 1}` } });
      }
      threads.push({ id, kind: t.kind as ThreadKind });
    }

    const attachments: Seed['attachments'] = [];
    for (const [i, size] of ATTACHMENT_SIZES.entries()) {
      const channelId = channels[i % channels.length]!;
      const o = await arranger.call('post', `/channels/${channelId}/messages`, {
        body: { content: `attachment ${size} bytes` },
        files: [{ name: `seed-${i}.bin`, data: Buffer.alloc(size, i % 251) }],
      });
      const rec = recordUpload(size, o);
      if (!rec.uploaded) warn(`upload of ${size} bytes refused: ${rec.status}/${rec.code ?? ''}`);
      const body = ok(o) ? (o as { body: { id: string; attachments: { id: string; url: string }[] } }).body : undefined;
      const att = body?.attachments[0];
      attachments.push({
        ...rec,
        ...(body ? { channelId, messageId: body.id } : {}),
        ...(att ? { attachmentId: att.id, url: att.url, expiresAt: cdnExpiry(att.url)?.toISOString() ?? null } : {}),
      });
    }

    const probe: Seed['probe'] = [];
    const post = async (kind: MessageKind, body: unknown) => {
      const m = await arranger.must<{ id: string }>('post', `/channels/${channels[0]}/messages`, { body });
      probe.push({ kind, channelId: channels[0]!, messageId: m.id });
    };
    for (let i = 0; i < 4; i++) await post('text', { content: `content probe text ${i + 1}` });
    for (const a of attachments.filter((x) => x.messageId).slice(0, 3)) probe.push({ kind: 'attachment', channelId: a.channelId!, messageId: a.messageId! });
    for (let i = 0; i < 2; i++) await post('embed', { embeds: [{ title: `content probe embed ${i + 1}`, description: 'S4' }] });
    await post('mention', { content: `<@${genie!.id}> content probe mention` });

    for (const t of threads.filter((x) => x.kind.endsWith('archived') || x.kind === 'private-archived-genie-member')) {
      await arranger.must('patch', `/channels/${t.id}`, { body: { archived: true } });
    }

    const seed: Seed = { runId: ledger.data.runId, guildId, channels, threadParent: parent, threads, attachments, probe, seedMs: Math.round(performance.now() - started) };
    await writeFile(seedFile(ledger.data.runId), `${JSON.stringify(seed, null, 2)}\n`);
    log(`seeded ${opts.messages} messages, ${threads.length} threads, ${attachments.filter((a) => a.uploaded).length}/${attachments.length} attachments in ${seed.seedMs} ms (run ${ledger.data.runId}${opts.keep ? ', kept' : ''})`);
  } finally {
    if (!opts.keep) await endOfRun(arranger, guildId, genie!.id, ledger);
  }
}

async function endOfRun(arranger: Api, guildId: string, genieId: string, ledger: LedgerHandle) {
  const plan = planCleanup({ kind: 'end-of-run', runId: ledger.data.runId }, await readLedgers(OUT_DIR), { channels: [], roles: [] });
  await applyCleanup(plan, new CleanupAdapter(arranger, guildId, genieId));
  if (plan.restoreGenieRole !== undefined) await markRestored(ledger, 'genieRole');
  if (plan.restoreEveryone !== undefined) await markRestored(ledger, 'everyone');
}

async function pageAll(genie: Api, targetId: string) {
  const latencies: number[] = [];
  let messages = 0;
  let before: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ limit: '100', ...(before ? { before } : {}) });
    const t0 = performance.now();
    const page = await genie.must<{ id: string }[]>('get', `/channels/${targetId}/messages`, { query: q });
    latencies.push(performance.now() - t0);
    messages += page.length;
    if (page.length < 100) break;
    before = page[page.length - 1]!.id;
  }
  return { target: targetId, pages: latencies.length, messages, ...pageStats(latencies.map(Math.round)) };
}

async function listing(genie: Api, route: `/${string}`, pick: (b: unknown) => string[]): Promise<Listing> {
  const o = await genie.call('get', route);
  if (ok(o)) return pick((o as { body: unknown }).body);
  return { error: o.kind === 'http' ? { status: o.status, ...(o.code !== undefined ? { code: o.code } : {}) } : { status: 0 } };
}

const threadIds = (b: unknown) => ((b as { threads?: { id: string }[] }).threads ?? []).map((t) => t.id);

/** FR-27–FR-30. Reads as genie; Manage Threads is removed and restored around listing (b). */
export async function s4Measure(c: Config, opts: { contentProbe: boolean }) {
  const guildId = c.GENIE_SPIKE_GUILD_ID!;
  const arranger = new Api(c.GENIE_SPIKE_ARRANGER_TOKEN!);
  const genie = new Api(c.GENIE_SPIKE_GENIE_TOKEN!);
  await guarded(arranger, guildId);
  const seed = await latestSeed();
  const genieUser = await whoAmI(genie);
  const report: Record<string, unknown> = { seedRunId: seed.runId, seedMs: seed.seedMs };

  if (opts.contentProbe) {
    const app = await genie.must<{ flags?: number }>('get', '/applications/@me');
    const intent = intentState(app.flags ?? 0);
    const rows = [];
    for (const p of seed.probe) {
      const m = await genie.must<{ content: string; attachments: unknown[]; embeds: unknown[]; components?: unknown[] }>(
        'get',
        `/channels/${p.channelId}/messages/${p.messageId}`,
      );
      rows.push(contentProbeRow({ content: m.content, attachments: m.attachments, embeds: m.embeds, components: m.components ?? [] }, p.kind, intent));
    }
    await writeFile(join(OUT_DIR, `s4-content-${intent}-${seed.runId}.json`), `${JSON.stringify(rows, null, 2)}\n`);
    log(`content probe (intent ${intent}): ${rows.filter((r) => r.matchesDocumented).length}/${rows.length} match the documented behaviour`);
    return;
  }

  report.paging = [];
  for (const target of [...seed.channels, ...seed.threads.map((t) => t.id)]) (report.paging as unknown[]).push(await pageAll(genie, target));

  const listings: Partial<Record<ListingName, Listing>> = {
    active: await listing(genie, `/guilds/${guildId}/threads/active`, threadIds),
    archivedPublic: await listing(genie, `/channels/${seed.threadParent}/threads/archived/public`, threadIds),
    archivedPrivate: await listing(genie, `/channels/${seed.threadParent}/threads/archived/private`, threadIds),
  };
  const withManageThreads = threadListingReport(seed.threads, listings);

  const ledger = await createLedger(OUT_DIR, { runId: newRun(), guildId, kept: false });
  let withoutManageThreads;
  try {
    if (!canSnapshot((await readLedgers(OUT_DIR)).filter((l) => l.runId !== ledger.data.runId), 'genieRole')) {
      throw new ExitError(8, "unrestored_snapshot: a ledger still holds an unrestored snapshot of genie's role");
    }
    const roleId = await genieRoleId(arranger, guildId, genieUser.id);
    const role = await arranger.must<{ permissions: string }>('get', `/guilds/${guildId}/roles/${roleId}`);
    await recordSnapshot(ledger, 'genieRole', role.permissions);
    const reduced = fromBits(role.permissions).filter((p) => p !== 'ManageThreads');
    await arranger.must('patch', `/guilds/${guildId}/roles/${roleId}`, { body: { permissions: toBits(reduced) } });
    withoutManageThreads = threadListingReport(seed.threads, {
      active: await listing(genie, `/guilds/${guildId}/threads/active`, threadIds),
      archivedPublic: await listing(genie, `/channels/${seed.threadParent}/threads/archived/public`, threadIds),
      archivedPrivate: await listing(genie, `/channels/${seed.threadParent}/threads/archived/private`, threadIds),
      joinedArchivedPrivate: await listing(genie, `/channels/${seed.threadParent}/users/@me/threads/archived/private`, threadIds),
    });
  } finally {
    await endOfRun(arranger, guildId, genieUser.id, ledger);
  }
  report.threads = { withManageThreads, withoutManageThreads };

  const attachments = [];
  for (const a of seed.attachments) {
    if (!a.uploaded || !a.messageId) {
      attachments.push({ size: a.size, uploaded: false, status: a.status, code: a.code });
      continue;
    }
    const msg = await genie.call('get', `/channels/${a.channelId}/messages/${a.messageId}`);
    if (!ok(msg)) {
      attachments.push({ size: a.size, uploaded: true, reResolve: 'message_deleted' });
      continue;
    }
    const fresh = (msg as { body: { attachments: { id: string; url: string; size: number }[] } }).body.attachments.find((x) => x.id === a.attachmentId);
    const newExpiry = fresh ? cdnExpiry(fresh.url) : null;
    const t0 = performance.now();
    const res = fresh ? await fetch(fresh.url) : undefined;
    const bytes = res?.ok ? (await res.arrayBuffer()).byteLength : 0;
    attachments.push({
      size: a.size,
      uploaded: true,
      expiresAt: a.expiresAt ?? null,
      reResolvedExpiresAt: newExpiry?.toISOString() ?? null,
      reResolvedLater: Boolean(newExpiry && a.expiresAt && newExpiry.getTime() > new Date(a.expiresAt).getTime()),
      downloadStatus: res?.status ?? null,
      bytes,
      downloadMs: Math.round(performance.now() - t0),
    });
  }
  report.attachments = attachments;
  await writeFile(join(OUT_DIR, `s4-report-${seed.runId}.json`), `${JSON.stringify(report, null, 2)}\n`);
  log(`wrote ${join(OUT_DIR, `s4-report-${seed.runId}.json`)}`);
}

/** FR-29: after the recorded expiry, try the original URL and a freshly re-resolved one. */
export async function s4CheckExpired(c: Config, file?: string) {
  const genie = new Api(c.GENIE_SPIKE_GENIE_TOKEN!);
  const seed = file ? (JSON.parse(await readFile(file, 'utf8')) as Seed) : await latestSeed();
  const rows = [];
  for (const a of seed.attachments.filter((x) => x.url)) {
    const old = await fetch(a.url!);
    const msg = await genie.call('get', `/channels/${a.channelId}/messages/${a.messageId}`);
    const fresh = ok(msg) ? (msg as { body: { attachments: { id: string; url: string }[] } }).body.attachments.find((x) => x.id === a.attachmentId) : undefined;
    const now = fresh ? await fetch(fresh.url) : undefined;
    rows.push({ size: a.size, expiresAt: a.expiresAt, checkedAt: new Date().toISOString(), oldUrlStatus: old.status, reResolvedStatus: now?.status ?? 'message_deleted' });
  }
  await writeFile(join(OUT_DIR, `s4-expired-${seed.runId}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  log(`checked ${rows.length} attachment URLs`);
}
