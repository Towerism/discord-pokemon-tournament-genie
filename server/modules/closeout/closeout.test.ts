import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAY_MS, type TranscriptJson } from '../../../shared/closeout';
import { PERMISSION_BITS as P } from '../../../shared/discord/permissions';
import { IDS } from '../../../test/support/discord-world';
import { type CloseoutWorld, GRACE_MS, closeoutWorld } from '../../../test/support/closeout-world';
import { PEOPLE } from '../../../test/support/provisioning-world';
import { ServiceError } from '../errors';
import { canSee } from '../../../shared/access/access';

let w: CloseoutWorld;
afterEach(async () => w?.dispose());

const HOUR = 3_600_000;
const refusal = async (fn: () => unknown) => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ServiceError) return { status: err.status, code: err.code, data: err.data };
    throw err;
  }
  throw new Error('expected a refusal');
};
const state = () => w.days.plan(w.dayId).day.state;
const ch = (name: string) => w.channel(name).id;
const files = (kind?: string) =>
  w.database.sqlite
    .prepare(
      `SELECT f.* FROM export_file f JOIN export_run r ON r.id = f.run_id WHERE f.day_id = ? AND f.superseded_by IS NULL AND r.state = 'succeeded' ${kind ? 'AND f.kind = ?' : ''} ORDER BY f.id`,
    )
    .all(...(kind ? [w.dayId, kind] : [w.dayId])) as { id: number; kind: string; name: string; path: string; sha256: string; channel_id: string; thread_id: string | null; parent_channel_id: string | null; high_water_message_id: string | null; event_id: number | null; superseded_by: number | null }[];
const transcriptOf = (channelId: string, threadId: string | null = null) => {
  const row = files(threadId ? 'thread_transcript_json' : 'transcript_json').find((f) => f.channel_id === channelId && f.thread_id === threadId)!;
  return JSON.parse(readFileSync(join(w.exportsDir, row.path), 'utf8')) as TranscriptJson;
};
const attachments = () =>
  w.database.sqlite.prepare('SELECT a.* FROM export_attachment a ORDER BY a.id').all() as { id: number; attachment_id: string; state: string; reason: string | null; file_id: number | null; discarded_by: string | null }[];
const mutationsOf = (method: string) => w.discord.mutations.filter((m) => m.method === method);
const headJudgePosts = () => [...w.discord.messages.values()].filter((m) => m.channelId === ch('head-judges') && m.authorId === w.botUserId && m.buttons.length === 0 && /Close-out/.test(m.content));
const admin = (target: string, content = 'late') => w.discord.post(PEOPLE.admin, target, { content });

describe('closing a day', () => {
  it('moves an open day to closing with its lock queued, and resumes only a failed close', async () => {
    w = await closeoutWorld();
    const { jobId } = await w.closeout.close(w.dayId, PEOPLE.brock);
    expect(state()).toBe('closing');
    expect(w.days.plan(w.dayId).day.closedBy).toBe(PEOPLE.brock);
    expect(w.jobsOf('lock').map((j) => [j.id, j.state])).toEqual([[jobId, 'queued']]);
    expect(await refusal(() => w.closeout.close(w.dayId, PEOPLE.brock))).toMatchObject({ status: 409, code: 'close_in_progress' });

    w.discord.failOn((call) => (call.method === 'setOverwrites' ? 'unavailable' : null));
    await w.jobs.runDue();
    w.discord.failOn(null);
    expect(w.jobsOf('lock')[0]!.state).toBe('failed');
    const resumed = await w.closeout.close(w.dayId, PEOPLE.brock);
    expect(resumed.jobId).not.toBe(jobId);
    await w.settle();
    expect(state()).toBe('closed');
    expect(await refusal(() => w.closeout.close(w.dayId, PEOPLE.brock))).toMatchObject({ status: 409, code: 'day_closed' });
  });

  it('refuses a draft day, a bot short of a permission, and an unreachable Discord, leaving the day as it was', async () => {
    w = await closeoutWorld();
    const { day } = w.days.createDay({ date: '2026-10-24', title: 'Draft' });
    expect(await refusal(() => w.closeout.close(day.id, PEOPLE.brock))).toMatchObject({ status: 409, code: 'day_not_open' });

    const botRole = w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!;
    botRole.permissions &= ~P.CreatePrivateThreads;
    expect(await refusal(() => w.closeout.close(w.dayId, PEOPLE.brock))).toEqual({
      status: 422,
      code: 'close_preconditions_failed',
      data: { problems: [{ code: 'missing_permissions', permissions: ['CreatePrivateThreads'] }] },
    });
    botRole.permissions |= P.CreatePrivateThreads;
    w.discord.unavailable = true;
    expect(await refusal(() => w.closeout.close(w.dayId, PEOPLE.brock))).toMatchObject({ status: 503, code: 'discord_unavailable' });
    w.discord.unavailable = false;
    expect(state()).toBe('open');
    expect(w.jobsOf('lock')).toEqual([]);
  });

  it('lists penalties still in their judge’s window, events without a Tournament ID, and the channels', async () => {
    w = await closeoutWorld();
    const first = await w.penalties.record(w.recordInput());
    w.clock.advance(60_000);
    const second = await w.penalties.record(w.recordInput());
    w.clock.advance(14 * 60_000 + 59_000);
    expect(w.closeout.preflight(w.dayId)).toEqual({
      recentPenalties: [{ penaltyId: second.penalty.id, eventId: w.tcg.id, number: second.penalty.number, recordedAt: second.penalty.recordedAt }],
      csvBlocked: [{ eventId: w.vgc.id, name: 'Cup VGC' }],
      channels: 6,
    });
    expect(first.penalty.id).not.toBe(second.penalty.id);
  });
});

describe('the lock', () => {
  it('lets nobody but the bot and Administrators post, react or open a thread, keeps the audience reading, and queues one export', async () => {
    w = await closeoutWorld();
    const thread = w.discord.addThread(ch('cup-floor'), { type: 'private', memberIds: [PEOPLE.ash], name: 'quiet' });
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    expect(w.jobsOf('lock')[0]!.state).toBe('succeeded');

    expect(() => w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'x' })).toThrow();
    expect(() => w.discord.post(PEOPLE.ash, thread, { content: 'x' })).toThrow();
    expect(() => w.discord.post(PEOPLE.organizer, ch('day-staff'), { content: 'x' })).toThrow();
    expect(() => w.discord.openThread(PEOPLE.ash, ch('cup-floor'), { type: 'public', name: 'y' })).toThrow();
    expect(w.discord.permissionsFor(PEOPLE.ash, ch('cup-floor')) & P.AddReactions).toBe(0n);
    expect(w.discord.permissionsFor(PEOPLE.ash, ch('cup-floor')) & P.ReadMessageHistory).toBe(P.ReadMessageHistory);
    expect(w.discord.permissionsFor(PEOPLE.organizer, ch('cup-floor')) & P.ViewChannel).toBe(P.ViewChannel);
    expect(() => admin(ch('cup-floor'))).not.toThrow();

    const panel = [...w.discord.messages.values()].find((m) => m.channelId === ch('head-judges') && m.authorId === w.botUserId && m.content.includes('closed'))!;
    expect(panel).toMatchObject({ content: 'This day is closed.', buttons: [] });
    expect(w.jobsOf('export').map((j) => j.state)).toEqual(['queued']);
  });

  it('writes nothing to a channel it already locked, even after the staff and roles changed', async () => {
    w = await closeoutWorld();
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    const written = mutationsOf('setOverwrites').length;
    w.discord.removeMember(IDS.guild, PEOPLE.misty);
    w.discord.guilds.get(IDS.guild)!.members.set(PEOPLE.ash, [IDS.headJudgeRole]);
    w.database.sqlite.prepare('UPDATE provisioned_channel SET locked_at = NULL').run();
    w.jobs.enqueue({ kind: 'lock', dayId: w.dayId });
    await w.settle();
    expect(mutationsOf('setOverwrites')).toHaveLength(written);
    expect(w.jobsOf('lock').at(-1)!.state).toBe('succeeded');
  });

  it('writes each channel at most once across a lost answer and the retry', async () => {
    w = await closeoutWorld();
    let seen = 0;
    const opened = mutationsOf('setOverwrites').length;
    w.discord.failOn((call) => (call.method === 'setOverwrites' && ++seen === 2 ? 'lost_answer' : null));
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    w.discord.failOn(null);
    expect(w.jobsOf('lock')[0]!.state).toBe('failed');
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    const targets = mutationsOf('setOverwrites').slice(opened).map((m) => m.target);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toHaveLength(6);
  });

  it('marks a channel deleted by hand as missing and goes on', async () => {
    w = await closeoutWorld();
    w.discord.channels.delete(ch('cup-vgc-floor'));
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    expect(w.jobsOf('lock')[0]!.state).toBe('succeeded');
    expect(w.provisioning.closeoutChannels(w.dayId).filter((c) => c.state === 'missing')).toHaveLength(1);
    expect(w.jobs.events(w.jobsOf('lock')[0]!.id).some((e) => e.level === 'warn')).toBe(true);
  });

  it('fails naming the channel, alarms organizers and posts to #head-judges once per failure; the revocation alarm stays until the lock lands', async () => {
    w = await closeoutWorld();
    w.days.putStaff(w.dayId, w.days.plan(w.dayId).staff.filter((s) => s.staffMemberId !== w.people.ash.id).map((s) => ({ staffMemberId: s.staffMemberId, events: s.events })));
    w.database.sqlite.prepare("DELETE FROM job WHERE kind = 'sync'").run();
    const penalties = ch('cup-penalties');
    w.discord.failOn((call) => (call.method === 'setOverwrites' && call.target === penalties ? 'unavailable' : null));
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    const lock = w.jobsOf('lock')[0]!;
    expect(lock.state).toBe('failed');
    expect(lock.error).toContain('cup-penalties');
    expect(state()).toBe('closing');
    const kinds = () => w.closeout.alarms().concat(w.provisioning.alarms() as never[]).map((a) => a.kind).sort();
    expect(kinds()).toEqual(['access_not_revoked', 'closeout_failed']);
    expect(headJudgePosts()).toHaveLength(1);
    expect(headJudgePosts()[0]!.content).not.toContain('cup-penalties');

    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    expect(headJudgePosts()).toHaveLength(2);
    w.discord.failOn(null);
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    expect(kinds()).toEqual([]);
  });
});

describe('the export', () => {
  it('writes a transcript of every channel and thread, ascending, with its mark, edits, embeds and replies', async () => {
    w = await closeoutWorld();
    const floor = ch('cup-floor');
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) {
      ids.push(w.discord.post(PEOPLE.ash, floor, { content: `m${i}`, ...(i === 2 ? { replyTo: ids[0]! } : {}), ...(i === 3 ? { embeds: [{ title: 'Deck', description: null, url: null, fields: [{ name: 'Round', value: '3' }] }] } : {}) }));
      w.clock.advance(1000);
    }
    w.discord.editAsAuthor(ids[1]!, 'm1 edited');
    const threads = [
      w.discord.addThread(floor, { type: 'public', name: 'pub' }),
      w.discord.addThread(floor, { type: 'public', archived: true, name: 'old' }),
      w.discord.addThread(floor, { type: 'private', name: 'priv' }),
      w.discord.addThread(floor, { type: 'private', archived: true, name: 'priv-old' }),
    ];
    const threadIds = threads.map((t) => admin(t, `in ${t}`));
    await w.closeAndExport();

    expect(state()).toBe('closed');
    const t = transcriptOf(floor);
    expect(t.messages.map((m) => m.id)).toEqual([...t.messages.map((m) => m.id)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
    expect(t.messages.filter((m) => m.authorId === PEOPLE.ash)).toHaveLength(250);
    expect(t.highWaterMessageId).toBe(t.messages.at(-1)!.id);
    expect(t.messages.find((m) => m.id === ids[1])).toMatchObject({ content: 'm1 edited', editedAt: expect.any(String) as string });
    expect(t.messages.find((m) => m.id === ids[2])!.referencedMessageId).toBe(ids[0]);
    expect(t.messages.find((m) => m.id === ids[3])!.embeds).toEqual([{ title: 'Deck', description: null, url: null, fields: [{ name: 'Round', value: '3' }] }]);
    threads.forEach((thread, i) => {
      const tt = transcriptOf(floor, thread);
      expect(tt.channel.parentChannelId).toBe(floor);
      expect(tt.highWaterMessageId).toBe(threadIds[i]);
    });
    expect(transcriptOf(ch('day-staff')).highWaterMessageId).not.toBeUndefined();
    expect(files('transcript_html')).toHaveLength(6);
    expect(files('thread_transcript_html')).toHaveLength(4);
    for (const f of files()) expect(await (await import('./files')).exportsFolder(w.exportsDir).check(f.path, f.sha256)).toBe('ok');
    const exportJob = w.jobsOf('export')[0]!;
    expect(w.jobs.events(exportJob.id).filter((e) => e.message.startsWith('Exported '))).toHaveLength(10);
  });

  it('marks an empty channel with no mark', async () => {
    w = await closeoutWorld();
    await w.closeAndExport();
    expect(transcriptOf(ch('cup-vgc-floor')).highWaterMessageId).toBeNull();
  });

  it('fails without Manage Threads before listing anything, and exports with a warning without message content', async () => {
    w = await closeoutWorld();
    const botRole = w.discord.guilds.get(IDS.guild)!.roles.find((r) => r.managed)!;
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    botRole.permissions &= ~P.ManageThreads;
    await w.settle();
    const job = w.jobsOf('export')[0]!;
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/^missing_channel_permissions: #.+: ManageThreads$/);
    expect(files()).toEqual([]);
    expect(state()).toBe('closing');
    expect(w.jobsOf('purge')).toEqual([]);

    botRole.permissions |= P.ManageThreads;
    w.discord.applications.get(IDS.app)!.flags = 0;
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.settle();
    expect(state()).toBe('closed');
    expect(w.database.sqlite.prepare("SELECT content_intent FROM export_run WHERE state = 'succeeded'").pluck().get()).toBe(0);
    expect(w.jobs.events(w.jobsOf('export')[1]!.id).some((e) => e.level === 'warn' && /Message Content/.test(e.message))).toBe(true);
  });

  it('saves attachments under the cap through a fresh URL, and records why each other one was skipped', async () => {
    let deleteOnResolve: string | null = null;
    let foreign: string | null = null;
    w = await closeoutWorld({
      wrap: (g) => ({
        ...g,
        async resolveAttachment(channelId, messageId, attachmentId) {
          if (messageId === deleteOnResolve) w.discord.messages.delete(messageId);
          const resolved = await g.resolveAttachment(channelId, messageId, attachmentId);
          return 'url' in resolved && messageId === foreign ? { ...resolved, url: resolved.url.replace(/127\.0\.0\.1:\d+/, 'evil.example') } : resolved;
        },
      }),
    });
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    const floor = ch('cup-floor');
    const post = (name: string, bytes: number) => w.discord.post(PEOPLE.ash, floor, { content: name, attachments: [{ filename: `${name}.bin`, data: Buffer.alloc(bytes, 1) }] });
    const attachmentOf = (messageId: string) => w.discord.messages.get(messageId)!.attachments[0]!.id;
    const small = post('small', 1024);
    const big = post('big', 1024 * 1024 + 1);
    deleteOnResolve = post('deleted', 10);
    const broken = post('broken', 10);
    w.discord.cdnBehaviour.set(attachmentOf(broken), 'error');
    const overlong = post('overlong', 10);
    w.discord.cdnBehaviour.set(attachmentOf(overlong), 'overlong');
    const redirected = post('redirected', 10);
    w.discord.cdnBehaviour.set(attachmentOf(redirected), 'redirect');
    const stalled = post('stalled', 10);
    w.discord.cdnBehaviour.set(attachmentOf(stalled), 'stall');
    foreign = post('foreign', 10);
    const expired = post('expired', 10);
    const bigId = attachmentOf(big);
    w.clock.advance(25 * HOUR);

    await w.closeAndExport();
    const byName = new Map(attachments().map((a) => [a.attachment_id, a]));
    const of = (messageId: string, id?: string) => byName.get(id ?? w.database.sqlite.prepare('SELECT attachment_id FROM export_attachment WHERE message_id = ?').pluck().get(messageId) as string)!;
    expect(of(small)).toMatchObject({ state: 'saved', reason: null });
    expect(of(expired)).toMatchObject({ state: 'saved' });
    expect(of(big, bigId)).toMatchObject({ state: 'skipped', reason: 'over_cap', file_id: null });
    expect(w.discord.cdnRequests.some((p) => p.includes(bigId))).toBe(false);
    expect(of(deleteOnResolve)).toMatchObject({ state: 'skipped', reason: 'message_deleted' });
    for (const id of [broken, overlong, redirected, stalled, foreign]) expect(of(id)).toMatchObject({ state: 'skipped', reason: 'download_failed' });
    const saved = files('attachment');
    expect(saved).toHaveLength(2);
    expect(readFileSync(join(w.exportsDir, saved[0]!.path))).toEqual(Buffer.alloc(1024, 1));
  });

  it('writes each event’s CSVs as the on-demand route does, and none for an event without a Tournament ID', async () => {
    w = await closeoutWorld();
    const side = w.days.addEvent(w.dayId, { name: 'Side', game: 'tcg', startTime: '12:00', tournamentId: '26-10-000124' });
    await w.penalties.record(w.recordInput());
    await w.penalties.record(w.recordInput({ notes: 'Second, with "quotes"' }));
    const third = await w.penalties.record(w.recordInput());
    await w.penalties.voidPenalty(w.dayId, third.penalty.id, { reason: 'duplicate', expectedRevision: 1, by: PEOPLE.brock });
    const expected = w.penalties.csv(w.dayId, w.tcg.id, false).body;
    const expectedVoided = w.penalties.csv(w.dayId, w.tcg.id, true).body;
    await w.closeAndExport();
    const csv = (eventId: number, kind: string) => files(kind).find((f) => f.event_id === eventId);
    expect(readFileSync(join(w.exportsDir, csv(w.tcg.id, 'penalties_csv')!.path), 'utf8')).toBe(expected);
    expect(readFileSync(join(w.exportsDir, csv(w.tcg.id, 'penalties_voided_csv')!.path), 'utf8')).toBe(expectedVoided);
    expect(csv(w.vgc.id, 'penalties_csv')).toBeUndefined();
    expect(readFileSync(join(w.exportsDir, csv(side.id, 'penalties_csv')!.path), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(w.closeout.exportsView(w.dayId, null).organizer!.csvBlocked).toEqual([{ eventId: w.vgc.id, name: 'Cup VGC' }]);
  });

  it('cleans a failed run away before the next, and never a run still writing', async () => {
    let reads = 0;
    let failing = true;
    w = await closeoutWorld({
      wrap: (g) => ({
        ...g,
        async readHistory(channelId, before) {
          if (failing && ++reads === 4) throw new Error('boom');
          return g.readHistory(channelId, before);
        },
      }),
    });
    await w.closeAndExport();
    expect(w.jobsOf('export')[0]!.state).toBe('failed');
    const failedRun = w.database.sqlite.prepare("SELECT id FROM export_run WHERE state = 'failed'").pluck().get() as number;
    expect(existsSync(join(w.exportsDir, String(w.dayId), String(failedRun)))).toBe(true);
    const writing = w.database.sqlite
      .prepare("INSERT INTO export_run (day_id, kind, state, started_at) VALUES (?, 'correction', 'running', 0) RETURNING id")
      .pluck()
      .get(w.dayId) as number;
    failing = false;
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.settle();
    expect(state()).toBe('closed');
    expect(existsSync(join(w.exportsDir, String(w.dayId), String(failedRun)))).toBe(false);
    expect(w.database.sqlite.prepare('SELECT id, state FROM export_run ORDER BY id').all()).toEqual([
      { id: writing, state: 'running' },
      { id: expect.any(Number) as number, state: 'succeeded' },
    ]);
    expect(files('transcript_json')).toHaveLength(6);

    w.closeout.recoverOnBoot();
    expect(w.database.sqlite.prepare('SELECT state FROM export_run WHERE id = ?').pluck().get(writing)).toBe('failed');
  });

  it('supersedes every file on a re-export, keeping the old ones, reusing saved attachments and keeping discards', async () => {
    w = await closeoutWorld();
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'a', attachments: [{ filename: 'a.png', data: Buffer.from('aa') }] });
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'b', attachments: [{ filename: 'b.bin', data: Buffer.alloc(1024 * 1024 + 1) }] });
    await w.closeAndExport();
    const before = files();
    const skipped = attachments().find((a) => a.state === 'skipped')!;
    await w.closeout.discard(w.dayId, [skipped.id], PEOPLE.organizer);
    const requests = w.discord.cdnRequests.length;
    admin(ch('cup-floor'));
    await w.closeout.reexport(w.dayId);
    await w.settle();
    const after = files();
    const transcriptsBefore = before.filter((f) => f.kind !== 'attachment');
    for (const old of transcriptsBefore) {
      const row = w.database.sqlite.prepare('SELECT superseded_by FROM export_file WHERE id = ?').pluck().get(old.id);
      expect(row, old.kind).not.toBeNull();
      expect(existsSync(join(w.exportsDir, old.path))).toBe(true);
    }
    expect(after.filter((f) => f.kind === 'attachment').map((f) => f.id)).toEqual(before.filter((f) => f.kind === 'attachment').map((f) => f.id));
    expect(w.discord.cdnRequests.length).toBe(requests);
    const current = attachments().filter((a) => !before.some((f) => f.kind === 'transcript_json' && w.database.sqlite.prepare('SELECT export_file_id FROM export_attachment WHERE id = ?').pluck().get(a.id) === f.id));
    expect(current.map((a) => a.state).sort()).toEqual(['discarded', 'saved']);
  });
});

describe('the grace period', () => {
  it('closes the day and schedules one purge at the grace end; Delete now moves it', async () => {
    w = await closeoutWorld();
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    const T = w.clock.now();
    await w.jobs.runDue();
    expect(w.days.plan(w.dayId).day).toMatchObject({ state: 'closed', closedAt: T, graceUntil: T + GRACE_MS });
    expect(w.jobsOf('purge')).toEqual([{ id: expect.any(Number) as number, state: 'queued', error: null, dueAt: T + GRACE_MS }]);

    w.clock.advance(HOUR);
    const { jobId } = w.closeout.purgeNow(w.dayId);
    expect(w.jobsOf('purge')).toEqual([{ id: jobId, state: 'queued', error: null, dueAt: T + HOUR }]);
    expect(w.days.plan(w.dayId).day.graceUntil).toBe(T + HOUR);
  });

  it('runs the purge exactly at the grace end', async () => {
    w = await closeoutWorld();
    await w.closeAndExport();
    const due = w.days.plan(w.dayId).day.graceUntil!;
    w.clock.set(due - 1);
    await w.settle();
    expect(state()).toBe('closed');
    w.clock.set(due);
    await w.settle();
    expect(state()).toBe('purged');
  });

  it('refuses Delete now on a day that isn’t closed', async () => {
    w = await closeoutWorld();
    expect(await refusal(() => w.closeout.purgeNow(w.dayId))).toMatchObject({ status: 409, code: 'day_not_closed' });
  });
});

describe('the purge', () => {
  const purge = async () => {
    w.closeout.purgeNow(w.dayId);
    await w.settle();
  };

  it('deletes every recorded channel and the category when nothing is newer, once', async () => {
    w = await closeoutWorld();
    const category = w.days.plan(w.dayId).day.categoryId!;
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'before close' });
    await w.closeAndExport();
    w.discord.channels.delete(ch('cup-vgc-floor'));
    await purge();
    expect(state()).toBe('purged');
    expect(w.discord.channelsOf(IDS.guild)).toEqual([]);
    expect(w.discord.channels.has(category)).toBe(false);
    expect(w.provisioning.closeoutChannels(w.dayId).every((c) => c.state !== 'present')).toBe(true);
    const calls = w.discord.restCalls;
    w.jobs.enqueue({ kind: 'purge', dayId: w.dayId });
    await w.settle();
    expect(w.discord.restCalls).toBe(calls);
  });

  it('refuses for each thing the export doesn’t hold, deleting nothing, with an alarm and one post', async () => {
    const cases: [string, () => void | Promise<void>, string][] = [
      ['a post in a channel', () => void admin(ch('cup-floor')), 'newer_messages'],
      ['a post in a thread', () => void admin(w.discord.addThread(ch('cup-floor'), { type: 'public', name: 'late' })), 'unexported_thread'],
      ['a new thread', () => void w.discord.openThread(PEOPLE.admin, ch('day-staff'), { type: 'private', name: 'late' }), 'unexported_thread'],
      [
        'a flipped byte',
        () => {
          const f = files('transcript_json')[0]!;
          const full = join(w.exportsDir, f.path);
          const bytes = readFileSync(full);
          bytes[0] = bytes[0]! ^ 1;
          writeFileSync(full, bytes);
        },
        'hash_mismatch',
      ],
      ['a deleted file', () => rmSync(join(w.exportsDir, files('transcript_html')[0]!.path)), 'file_missing'],
      ['intent off', () => void w.database.sqlite.prepare('UPDATE export_run SET content_intent = 0').run(), 'content_intent_missing'],
    ];
    for (const [what, act, code] of cases) {
      w = await closeoutWorld();
      admin(w.discord.addThread(ch('cup-floor'), { type: 'public', name: 'early' }));
      await w.closeAndExport();
      const before = w.discord.channelsOf(IDS.guild).length;
      await act();
      await purge();
      expect(state(), what).toBe('closed');
      expect(w.discord.channelsOf(IDS.guild), what).toHaveLength(before);
      const refusalNow = w.closeout.exportsView(w.dayId, null).organizer!.refusal!;
      expect(refusalNow.reasons.map((r) => r.code), what).toContain(code);
      expect(w.closeout.alarms().map((a) => a.kind), what).toEqual(['purge_refused']);
      expect(headJudgePosts(), what).toHaveLength(1);
      expect(w.jobsOf('purge').at(-1)!.error, what).toMatch(/^purge_refused: \d+ reasons$/);
      await w.dispose();
    }
    w = await closeoutWorld();
  });

  it('refuses while an attachment is skipped', async () => {
    w = await closeoutWorld();
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'b', attachments: [{ filename: 'b.bin', data: Buffer.alloc(1024 * 1024 + 1) }] });
    await w.closeAndExport();
    await purge();
    expect(w.closeout.exportsView(w.dayId, null).organizer!.refusal!.reasons).toEqual([{ code: 'skipped_attachments', count: 1 }]);
  });

  it('stops before a channel that gained a message after the gate, keeping the rest', async () => {
    w = await closeoutWorld();
    await w.closeAndExport();
    let deletes = 0;
    const second = w.provisioning.closeoutChannels(w.dayId).filter((c) => c.state === 'present')[1]!.discordChannelId;
    w.discord.failOn((call) => {
      if (call.method === 'deleteChannel' && ++deletes === 1) admin(second);
      return null;
    });
    await purge();
    expect(deletes).toBe(1);
    expect(state()).toBe('closed');
    expect(w.discord.channels.has(second)).toBe(true);
    expect(w.closeout.exportsView(w.dayId, null).organizer!.refusal!.reasons.map((r) => r.code)).toEqual(['newer_messages']);
  });

  it('never deletes a channel holding a message newer than its mark, whichever call crashes (enumerated)', async () => {
    // A post into the channel whose delete is in flight is the one window no design closes (NFR-5): post into the next.
    for (let crashAt = 0; crashAt < 5; crashAt++) {
      w = await closeoutWorld();
      await w.closeAndExport();
      const present = w.provisioning.closeoutChannels(w.dayId).filter((c) => c.state === 'present');
      const late = present[crashAt + 1]!.discordChannelId;
      let calls = 0;
      w.discord.failOn((_call) => {
        if (calls === crashAt) admin(late);
        return calls++ === crashAt ? (crashAt % 2 ? 'lost_answer' : 'unavailable') : null;
      });
      await purge();
      w.discord.failOn(null);
      await purge();
      expect(w.discord.channels.has(late), `crash at ${crashAt}`).toBe(true);
      await w.dispose();
    }
    w = await closeoutWorld();
  });

  it('leaves the category and a channel Genie didn’t record, with a warning', async () => {
    w = await closeoutWorld();
    const category = w.days.plan(w.dayId).day.categoryId!;
    const gateway = w.discord.create('fake-bot-token-0123456789').gateway;
    const orphan = await gateway.createChannel(IDS.guild, { name: 'someone-else', parentId: category, overwrites: [] });
    await w.closeAndExport();
    await purge();
    expect(state()).toBe('purged');
    expect(w.discord.channels.has(category)).toBe(true);
    expect(w.discord.channels.has(orphan)).toBe(true);
    const job = w.jobsOf('purge').at(-1)!;
    expect(w.jobs.events(job.id).some((e) => e.level === 'warn' && e.message.includes('category'))).toBe(true);
  });
});

describe('clearing a refusal', () => {
  it('re-exports newer messages, then purges at the later of now and the grace end; its own alerts never count', async () => {
    w = await closeoutWorld();
    await w.closeAndExport();
    admin(ch('cup-floor'));
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    expect(state()).toBe('closed');
    expect(headJudgePosts()).toHaveLength(1);
    await w.closeout.reexport(w.dayId);
    await w.settle();
    expect(state()).toBe('purged');
  });

  it('retries a skipped attachment after the cap is raised, then purges', async () => {
    w = await closeoutWorld();
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'b', attachments: [{ filename: 'b.bin', data: Buffer.alloc(1024 * 1024 + 1) }] });
    await w.closeAndExport();
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    expect(state()).toBe('closed');
    expect(headJudgePosts()).toHaveLength(1);
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 2 });
    await w.closeout.retryAttachments(w.dayId);
    await w.settle();
    expect(attachments().map((a) => a.state)).toEqual(['saved']);
    expect(state()).toBe('purged');
    expect(await refusal(() => w.closeout.retryAttachments(w.dayId))).toMatchObject({ code: 'day_not_closed' });
  });

  it('discards skipped attachments with who and when, then purges; refuses one that isn’t skipped, and while a job runs', async () => {
    w = await closeoutWorld();
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    for (const name of ['a', 'b']) w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: name, attachments: [{ filename: `${name}.bin`, data: Buffer.alloc(1024 * 1024 + 1) }] });
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'c', attachments: [{ filename: 'c.png', data: Buffer.from('c') }] });
    await w.closeAndExport();
    const [a, b, c] = attachments();
    expect(await refusal(() => w.closeout.discard(w.dayId, [a!.id, c!.id], PEOPLE.organizer))).toEqual({ status: 422, code: 'not_skipped', data: { attachmentIds: [c!.id] } });
    expect(attachments().map((x) => x.state)).toEqual(['skipped', 'skipped', 'saved']);

    await w.closeout.reexport(w.dayId);
    expect(await refusal(() => w.closeout.discard(w.dayId, [a!.id], PEOPLE.organizer))).toMatchObject({ status: 409, code: 'closeout_in_progress' });
    expect(await refusal(() => w.closeout.reexport(w.dayId))).toMatchObject({ status: 409, code: 'closeout_in_progress' });
    await w.settle();

    const current = w.closeout.exportsView(w.dayId, null).organizer!.skipped;
    expect(current).toHaveLength(2);
    const result = await w.closeout.discard(w.dayId, current.map((x) => x.id), PEOPLE.organizer);
    expect(result).toEqual({ discarded: 2, purgeJobId: expect.any(Number) as number });
    expect(attachments().filter((x) => current.some((y) => y.id === x.id)).every((x) => x.state === 'discarded' && x.discarded_by === PEOPLE.organizer)).toBe(true);
    const log = w.logs.find((l) => l.msg === 'attachments_discarded')!;
    expect(log.fields).toMatchObject({ dayId: w.dayId, by: PEOPLE.organizer, count: 2, attachmentIds: current.map((x) => x.id) });
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    expect(state()).toBe('purged');
    expect(b).toBeDefined();
  });
});

describe('corrections after close', () => {
  const csvText = (fileId: number) => readFileSync(join(w.exportsDir, w.database.sqlite.prepare('SELECT path FROM export_file WHERE id = ?').pluck().get(fileId) as string), 'utf8');

  it('re-exports the event’s CSVs on an organizer’s edit and void, keeping the old file, and edits the card', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    const other = await w.penalties.record(w.recordInput());
    await w.closeAndExport();
    const old = files('penalties_csv')[0]!;
    const oldText = readFileSync(join(w.exportsDir, old.path), 'utf8');
    const edited = await w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'Corrected note.' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true });
    expect(edited.penalty.revision).toBe(2);
    expect(csvText(edited.exportFileId!)).toContain('Corrected note.');
    expect(readFileSync(join(w.exportsDir, old.path), 'utf8')).toBe(oldText);
    expect(w.database.sqlite.prepare('SELECT superseded_by FROM export_file WHERE id = ?').pluck().get(old.id)).toBe(edited.exportFileId);
    expect(w.messagesIn('cup-penalties').some((m) => m?.embed?.fields.some((f) => f.value === 'Corrected note.'))).toBe(true);

    await w.closeout.correctPenalty(w.dayId, other.penalty.id, { kind: 'void', reason: 'duplicate' }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true });
    const voided = files('penalties_voided_csv').find((f) => f.event_id === w.tcg.id)!;
    expect(readFileSync(join(w.exportsDir, voided.path), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);

    expect(await refusal(() => w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'x' } }, { expectedRevision: 2, by: PEOPLE.brock, organizer: false }))).toMatchObject({
      status: 403,
      code: 'closed_organizer_only',
    });
    expect(w.penalties.get(penalty.id)!.revision).toBe(2);
  });

  it('answers no file for an event without a Tournament ID, and makes no Discord call on a purged day', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput({ eventId: w.vgc.id, judgeStaffMemberId: w.people.misty.id, recordedBy: PEOPLE.misty }));
    await w.closeAndExport();
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    expect(state()).toBe('purged');
    const calls = w.discord.restCalls;
    const out = await w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'x' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true });
    expect(out.exportFileId).toBeNull();
    expect(w.discord.restCalls).toBe(calls);
  });

  it('refuses while the day is closing', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.closeout.close(w.dayId, PEOPLE.brock);
    expect(await refusal(() => w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'x' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true }))).toMatchObject({
      status: 409,
      code: 'day_closing',
    });
  });

  it('never lets a re-export’s older CSV replace a correction’s newer one', async () => {
    // The re-export writes Cup's CSV from the old penalties, then waits on Side's; a correction to Cup lands meanwhile.
    let hold: (() => void) | null = null;
    let sideId = -1;
    let holding = false;
    w = await closeoutWorld({
      beforeCsvWrite: async (eventId) => {
        if (!holding || eventId !== sideId) return;
        holding = false;
        await new Promise<void>((resolve) => (hold = resolve));
      },
    });
    sideId = w.days.addEvent(w.dayId, { name: 'Side', game: 'tcg', startTime: '12:00', tournamentId: '26-10-000124' }).id;
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.closeAndExport();
    holding = true;
    await w.closeout.reexport(w.dayId);
    const reexporting = w.jobs.runDue();
    while (!hold) await new Promise((resolve) => setImmediate(resolve));
    await w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'Newest.' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true });
    (hold as () => void)();
    await reexporting;
    const current = files('penalties_csv').filter((f) => f.event_id === w.tcg.id);
    expect(current).toHaveLength(1);
    expect(csvText(current[0]!.id)).toContain('Newest.');
  });

  it('answers correction_export_failed when the CSV can’t be written, keeps the change, and Rewrite CSVs recovers', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.closeAndExport();
    const dayFolder = join(w.exportsDir, String(w.dayId));
    chmodSync(dayFolder, 0o500);
    try {
      expect(await refusal(() => w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'Kept.' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true }))).toMatchObject({
        status: 500,
        code: 'correction_export_failed',
      });
    } finally {
      chmodSync(dayFolder, 0o700);
    }
    expect(w.penalties.get(penalty.id)!.notes).toBe('Kept.');
    expect(w.closeout.alarms()).toEqual([expect.objectContaining({ kind: 'closeout_failed', jobKind: 'correction' })]);
    expect(await w.closeout.rewriteCsvs(w.dayId)).toEqual({ written: 1 });
    expect(csvText(files('penalties_csv')[0]!.id)).toContain('Kept.');
    expect(w.closeout.alarms()).toEqual([]);
  });

  it('writes an event’s CSVs once its Tournament ID is set after close', async () => {
    w = await closeoutWorld();
    await w.closeAndExport();
    expect(w.closeout.exportsView(w.dayId, null).organizer!.csvBlocked).toHaveLength(1);
    await w.closeout.setTournamentId(w.dayId, w.vgc.id, '26-10-000125');
    expect(files('penalties_csv').some((f) => f.event_id === w.vgc.id)).toBe(true);
    expect(w.closeout.exportsView(w.dayId, null).organizer!.csvBlocked).toEqual([]);
  });
});

describe('retention', () => {
  it('sweeps a purged day’s transcripts, then its penalties, from its close; never a day that isn’t purged', async () => {
    w = await closeoutWorld();
    await w.penalties.record(w.recordInput());
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'a', attachments: [{ filename: 'a.png', data: Buffer.from('aa') }] });
    await w.closeAndExport();
    const T = w.days.plan(w.dayId).day.closedAt!;
    await w.closeout.reexport(w.dayId);
    await w.settle();
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    const sweep = async (at: number) => {
      w.clock.set(at);
      w.jobs.schedule({ kind: 'retention_sweep', dayId: null, dueAt: at });
      await w.jobs.runDue();
    };
    const count = (sql: string) => w.database.sqlite.prepare(sql).pluck().get();
    await sweep(T + 90 * DAY_MS - 1);
    expect(count("SELECT count(*) FROM export_file WHERE kind = 'transcript_json'")).toBe(12);
    await sweep(T + 90 * DAY_MS);
    expect(count("SELECT count(*) FROM export_file WHERE kind NOT IN ('penalties_csv', 'penalties_voided_csv')")).toBe(0);
    expect(count('SELECT count(*) FROM export_attachment')).toBe(0);
    expect(count('SELECT count(*) FROM penalty')).toBe(1);
    expect(count('SELECT count(*) FROM export_file')).toBeGreaterThan(0);
    await sweep(T + 365 * DAY_MS);
    expect(count('SELECT count(*) FROM export_file')).toBe(0);
    expect(count('SELECT count(*) FROM penalty')).toBe(0);
    expect(existsSync(join(w.exportsDir, String(w.dayId)))).toBe(false);
    expect(w.closeout.exportsView(w.dayId, null).swept).toEqual({ transcriptsAt: T + 90 * DAY_MS, penaltiesAt: T + 365 * DAY_MS });
    expect(w.jobs.active(0)).toEqual([]);
    const next = w.database.sqlite.prepare("SELECT due_at FROM job WHERE kind = 'retention_sweep' AND state = 'queued'").pluck().all();
    expect(next).toEqual([T + 365 * DAY_MS + DAY_MS]);
  });

  it('keeps everything of a closed day that was never purged', async () => {
    w = await closeoutWorld();
    await w.penalties.record(w.recordInput());
    await w.closeAndExport();
    const T = w.days.plan(w.dayId).day.closedAt!;
    w.database.sqlite.prepare("DELETE FROM job WHERE kind = 'purge'").run();
    w.clock.set(T + 400 * DAY_MS);
    w.jobs.schedule({ kind: 'retention_sweep', dayId: null, dueAt: w.clock.now() });
    await w.jobs.runDue();
    expect(w.database.sqlite.prepare('SELECT count(*) FROM penalty').pluck().get()).toBe(1);
    expect(files('transcript_json')).toHaveLength(6);
  });

  it('schedules one sweep at boot, however many boots', () => {
    return (async () => {
      w = await closeoutWorld();
      w.closeout.recoverOnBoot();
      w.closeout.recoverOnBoot();
      expect(w.database.sqlite.prepare("SELECT count(*) FROM job WHERE kind = 'retention_sweep' AND state = 'queued'").pluck().get()).toBe(1);
    })();
  });
});

describe('settings', () => {
  it('refuses a transcript retention not longer than the grace period', async () => {
    w = await closeoutWorld();
    expect(await refusal(() => w.closeout.putSettings({ transcriptRetentionDays: 7, penaltyRetentionDays: 365, attachmentCapMb: 25 }))).toMatchObject({
      status: 422,
      code: 'retention_not_longer_than_grace',
    });
    expect(w.closeout.putSettings({ transcriptRetentionDays: 8, penaltyRetentionDays: 365, attachmentCapMb: 25 })).toEqual({
      transcriptRetentionDays: 8,
      penaltyRetentionDays: 365,
      attachmentCapMb: 25,
      purgeGraceHours: 168,
    });
  });
});

describe('what close-out logs', () => {
  it('never logs message content, file or thread names, or notes', async () => {
    w = await closeoutWorld();
    await w.penalties.record(w.recordInput({ notes: 'secret-notes' }));
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'secret-content-xyz', attachments: [{ filename: 'secret-file.png', data: Buffer.from('x') }] });
    admin(w.discord.addThread(ch('cup-floor'), { type: 'public', name: 'secret-thread' }), 'secret-content-xyz');
    await w.closeAndExport();
    w.discord.openThread(PEOPLE.admin, ch('cup-floor'), { type: 'public', name: 'secret-thread' });
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    const jobText = JSON.stringify(w.database.sqlite.prepare('SELECT j.error, e.message, e.data FROM job j LEFT JOIN job_event e ON e.job_id = j.id').all());
    const logText = JSON.stringify(w.logs);
    const posts = JSON.stringify(headJudgePosts().map((m) => m.content));
    for (const secret of ['secret-content-xyz', 'secret-file', 'secret-thread', 'secret-notes']) {
      expect(jobText).not.toContain(secret);
      expect(logText).not.toContain(secret);
      expect(posts).not.toContain(secret);
    }
  });
});

describe('edges', () => {
  it('skips a channel deleted between the lock and the export, and a thread deleted between listing and reading', async () => {
    let vanishing: string | null = null;
    w = await closeoutWorld({
      wrap: (g) => ({
        ...g,
        async readHistory(channelId, before) {
          return channelId === vanishing ? null : g.readHistory(channelId, before);
        },
      }),
    });
    vanishing = w.discord.addThread(ch('cup-floor'), { type: 'public', name: 'gone' });
    await w.closeout.close(w.dayId, PEOPLE.brock);
    await w.jobs.runDue();
    w.discord.channels.delete(ch('cup-vgc-floor'));
    await w.settle();
    expect(state()).toBe('closed');
    expect(files('transcript_json')).toHaveLength(5);
    expect(files('thread_transcript_json')).toHaveLength(0);
    const events = w.jobs.events(w.jobsOf('export')[0]!.id).filter((e) => e.level === 'warn');
    expect(events).toHaveLength(2);
  });

  it('downloads a saved attachment again on a re-export when its file is gone', async () => {
    w = await closeoutWorld();
    w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: 'a', attachments: [{ filename: 'a.png', data: Buffer.from('aa') }] });
    await w.closeAndExport();
    rmSync(join(w.exportsDir, files('attachment')[0]!.path));
    const requests = w.discord.cdnRequests.length;
    await w.closeout.reexport(w.dayId);
    await w.settle();
    expect(w.discord.cdnRequests.length).toBe(requests + 1);
    expect(w.closeout.exportsView(w.dayId, null).transcripts.find((t) => t.channelId === ch('cup-floor'))!.attachments).toEqual([
      expect.objectContaining({ state: 'saved', filename: 'a.png' }),
    ]);
  });

  it('keeps the purge waiting when a retry or a discard leaves an attachment skipped', async () => {
    w = await closeoutWorld();
    w.closeout.putSettings({ transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 1 });
    for (const name of ['a', 'b']) w.discord.post(PEOPLE.ash, ch('cup-floor'), { content: name, attachments: [{ filename: `${name}.bin`, data: Buffer.alloc(1024 * 1024 + 1) }] });
    await w.closeAndExport();
    const purgeDue = w.jobsOf('purge')[0]!.dueAt;
    await w.closeout.retryAttachments(w.dayId);
    await w.settle();
    expect(w.closeout.exportsView(w.dayId, null).organizer!.skipped).toHaveLength(2);
    const [first] = w.closeout.exportsView(w.dayId, null).organizer!.skipped;
    expect(w.closeout.discard(w.dayId, [first!.id], PEOPLE.organizer)).toEqual({ discarded: 1, purgeJobId: null });
    expect(w.jobsOf('purge').map((j) => j.dueAt)).toEqual([purgeDue]);
  });

  it('refuses work on a day in the wrong state', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    expect(await refusal(() => w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'edit', patch: { notes: 'x' } }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true }))).toMatchObject({
      code: 'day_not_open',
    });
    expect(await refusal(() => w.closeout.rewriteCsvs(w.dayId))).toMatchObject({ status: 409, code: 'day_not_closed' });
    expect(await refusal(() => w.closeout.reexport(w.dayId))).toMatchObject({ code: 'day_not_closed' });
    expect(await refusal(() => w.closeout.retryAttachments(w.dayId))).toMatchObject({ code: 'day_not_closed' });
    expect(await refusal(() => w.closeout.discard(w.dayId, [1], PEOPLE.organizer))).toMatchObject({ code: 'day_not_closed' });
    w.jobs.enqueue({ kind: 'purge', dayId: w.dayId });
    await w.jobs.runDue();
    expect(w.jobsOf('purge')[0]).toMatchObject({ state: 'failed', error: 'day_not_closed' });
    expect(w.discord.channelsOf(IDS.guild)).toHaveLength(7);

    await w.closeAndExport();
    expect(await refusal(() => w.closeout.retryAttachments(w.dayId))).toMatchObject({ status: 409, code: 'nothing_skipped' });
  });

  it('answers 503 when the bot is no longer in the guild at close', async () => {
    w = await closeoutWorld();
    w.discord.removeMember(IDS.guild, w.botUserId);
    expect(await refusal(() => w.closeout.close(w.dayId, PEOPLE.brock))).toMatchObject({ status: 503, code: 'discord_unavailable' });
    expect(state()).toBe('open');
  });

  it('refuses corrections and Rewrite CSVs once the penalties are swept, and sets a Tournament ID without writing', async () => {
    w = await closeoutWorld();
    const { penalty } = await w.penalties.record(w.recordInput());
    await w.closeAndExport();
    w.closeout.purgeNow(w.dayId);
    await w.settle();
    w.clock.advance(400 * DAY_MS);
    w.jobs.schedule({ kind: 'retention_sweep', dayId: null, dueAt: w.clock.now() });
    await w.jobs.runDue();
    expect(await refusal(() => w.closeout.correctPenalty(w.dayId, penalty.id, { kind: 'void', reason: 'x' }, { expectedRevision: 1, by: PEOPLE.organizer, organizer: true }))).toMatchObject({
      status: 404,
    });
    expect(await refusal(() => w.closeout.rewriteCsvs(w.dayId))).toMatchObject({ status: 404 });
    expect((await w.closeout.setTournamentId(w.dayId, w.vgc.id, '26-10-000125')).tournamentId).toBe('26-10-000125');
    expect(files('penalties_csv')).toEqual([]);
  });

  it('shows a head judge only their files, never a private thread or another event’s, and nothing to download that isn’t a file', async () => {
    w = await closeoutWorld();
    await w.penalties.record(w.recordInput());
    const priv = w.discord.addThread(ch('cup-floor'), { type: 'private', name: 'private' });
    const pub = w.discord.addThread(ch('cup-floor'), { type: 'public', name: 'public' });
    for (const t of [priv, pub]) admin(t);
    await w.closeAndExport();
    const brock = { userId: PEOPLE.brock, grant: 'event_head_judge' as const, holdsHeadJudgeRole: false };
    const view = w.closeout.exportsView(w.dayId, brock, w.provisioning.accessPlan(w.dayId, brock));
    expect(view.organizer).toBeUndefined();
    expect(view.csvs.map((c) => c.eventId)).toEqual([w.tcg.id]);
    expect(view.transcripts.map((t) => t.name).sort()).toEqual(['cup-floor', 'cup-penalties', 'day-staff', 'head-judges']);
    expect(view.transcripts.find((t) => t.name === 'cup-floor')!.threads.map((t) => t.name)).toEqual(['public']);

    const all = w.closeout.exportsView(w.dayId, null);
    expect(all.transcripts.find((t) => t.name === 'cup-floor')!.threads.map((t) => t.name).sort()).toEqual(['private', 'public']);
    const privateFile = all.transcripts.find((t) => t.name === 'cup-floor')!.threads.find((t) => t.name === 'private')!.json.id;
    const download = w.closeout.download(privateFile)!;
    expect(canSee(brock, download.resource, w.provisioning.accessPlan(w.dayId, brock))).toBe(false);
    expect(w.closeout.download(999_999)).toBeNull();
    w.database.sqlite.prepare("UPDATE export_file SET path = '../../app.db' WHERE id = ?").run(privateFile);
    expect(w.closeout.download(privateFile)!.path).toBeNull();
    expect(w.logs.some((l) => l.level === 'error' && /leaves the exports folder/.test(l.msg))).toBe(true);
  });
});
