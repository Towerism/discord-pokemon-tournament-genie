import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { CSP_TRANSCRIPT } from '../../shared/closeout';
import { PERMISSION_BITS as P } from '../../shared/discord/permissions';
import { IDS, storeWorld } from '../support/discord-world';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { completeSetup, expectNoSecrets, loginThroughDiscord, replyTexts } from '../support/flows';
import { type Genie, startGenie } from '../support/genie-process';
import { type Browser, type Reply, browser } from '../support/http-client';

// The close-out routes on the built app, over the discord.js adapter and the HTTP fake of Discord and its CDN.

const ASH = '100000000000000301'; // LC head judge
const BROCK = '100000000000000302'; // LC judge
const GARY = '100000000000000304'; // VGC head judge
const OTHER = '100000000000000306'; // head judge of another day
const ADMIN = '100000000000000307';
const ADMIN_ROLE = '200000000000000009';
const EVIL = '../../evil".html';

let fake: FakeDiscord;
let discord: FakeDiscordHttp;
let genie: Genie;
let organizer: Browser;
let ash: Browser;
let brock: Browser;
let gary: Browser;
let otherDayHeadJudge: Browser;
let anonymous: Browser;
let dayId: number;
let lcId: number;
let vgcId: number;

const ok = (r: Reply, status = 200) => {
  expect(r.status, r.text).toBe(status);
  return r.json<Record<string, unknown>>();
};
const code = (r: Reply) => r.json<{ data?: { code?: string } }>().data?.code ?? null;
const channelId = (name: string) => [...fake.channels.values()].find((c) => c.name === name)!.id;
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

async function signedIn(userId: string): Promise<Browser> {
  const b = browser(genie.url);
  expect((await loginThroughDiscord(b, discord, userId)).location).toBe('/');
  return b;
}

/** Waits on the day's state through the API, never on a timeout. */
async function dayState(want: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { day, latestJob } = ok(await organizer.get(`/api/days/${dayId}`)) as { day: { state: string }; latestJob: { state: string; kind: string; error: string | null } | null };
    // The purge waiting for the grace end stays queued: only a running or due job counts as unfinished.
    const busy = latestJob && latestJob.kind !== 'purge' && (latestJob.state === 'queued' || latestJob.state === 'running');
    if (day.state === want && !busy) return;
    if (latestJob?.state === 'failed') throw new Error(`${latestJob.kind} failed: ${latestJob.error}`);
    if (Date.now() > deadline) throw new Error(`day still ${day.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Exports = {
  csvs: { eventId: number; files: { id: number; kind: string; sha256: string; supersededBy: number | null }[] }[];
  transcripts: { name: string; channelId: string; json: { id: number; sha256: string }; html: { id: number; sha256: string }; threads: { name: string; json: { id: number } }[]; attachments: { fileId: number | null; filename: string; state: string }[] }[];
  organizer?: { csvBlocked: { eventId: number }[] };
};

beforeAll(async () => {
  fake = storeWorld();
  fake.guilds.get(IDS.guild)!.ownerId = IDS.owner;
  fake.addRole(IDS.guild, { id: ADMIN_ROLE, name: 'Admin', permissions: P.Administrator });
  for (const [userId, name] of [
    [ASH, 'Ash'],
    [BROCK, 'Brock'],
    [GARY, 'Gary'],
    [OTHER, 'Other'],
  ] as const) {
    fake.addMember(IDS.guild, userId, [], { displayName: name, username: name.toLowerCase() });
  }
  fake.addMember(IDS.guild, ADMIN, [ADMIN_ROLE], { displayName: 'Admin', username: 'admin' });
  fake.guilds.get(IDS.guild)!.roles[0]!.permissions = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
  discord = await startFakeDiscordHttp(fake);
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000', GENIE_PURGE_GRACE: '7d' } });
  const owner = browser(genie.url);
  anonymous = browser(genie.url);
  await completeSetup(owner, genie, discord);
  organizer = await signedIn(IDS.organizer);

  const staff = async (displayName: string, discordUserId: string, playerId: string) =>
    (ok(await organizer.post('/api/staff', { displayName, discordUserId, playerId }), 201) as { id: number }).id;
  const ashId = await staff('Ash', ASH, '00111');
  const brockId = await staff('Brock', BROCK, '00222');
  const garyId = await staff('Gary', GARY, '00444');
  const otherId = await staff('Other', OTHER, '00666');
  dayId = (ok(await organizer.post('/api/days', { date: '2026-10-17', title: 'October LC' }), 201) as { day: { id: number } }).day.id;
  lcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'LC', game: 'tcg', startTime: '10:00', tournamentId: '26-10-000123' }), 201) as { id: number }).id;
  vgcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'VGC', game: 'vgc', startTime: '11:30', tournamentId: '26-10-000124' }), 201) as { id: number }).id;
  ok(
    await organizer.put(`/api/days/${dayId}/staff`, {
      staff: [
        { staffMemberId: ashId, events: [{ eventId: lcId, role: 'headjudge' }] },
        { staffMemberId: brockId, events: [{ eventId: lcId, role: 'judge' }] },
        { staffMemberId: garyId, events: [{ eventId: vgcId, role: 'headjudge' }] },
      ],
    }),
  );
  const other = (ok(await organizer.post('/api/days', { date: '2026-10-18', title: 'Other' }), 201) as { day: { id: number } }).day.id;
  const otherEvent = (ok(await organizer.post(`/api/days/${other}/events`, { name: 'GO', game: 'go', startTime: '09:00' }), 201) as { id: number }).id;
  ok(await organizer.put(`/api/days/${other}/staff`, { staff: [{ staffMemberId: otherId, events: [{ eventId: otherEvent, role: 'headjudge' }] }] }));
  ok(await organizer.post(`/api/days/${dayId}/open`), 202);
  await dayState('open');

  // Content for the export: more than one page of history, a thread of every listing, a text attachment.
  const catalog = ok(await organizer.get('/api/catalog')) as { categories: { id: number; label: string }[]; types: { id: number; label: string }[] };
  ok(
    await organizer.post(`/api/days/${dayId}/penalties`, {
      idempotencyKey: randomUUID(),
      eventId: lcId,
      round: 2,
      competitorPlayerId: '0012345',
      categoryId: catalog.categories.find((c) => c.label === 'Game Play')!.id,
      severity: 'Minor',
      penaltyTypeId: catalog.types.find((t) => t.label === 'Warning')!.id,
      notes: 'First note.',
      judgeStaffMemberId: brockId,
    }),
    201,
  );
  const floor = channelId('lc-floor');
  for (let i = 0; i < 120; i++) fake.post(ADMIN, floor, { content: `message ${i}` });
  fake.post(ADMIN, floor, { content: 'with a file', attachments: [{ filename: EVIL, data: Buffer.from('attachment-bytes'), contentType: 'text/html' }] });
  for (const [type, archived] of [
    ['public', false],
    ['public', true],
    ['private', false],
    ['private', true],
  ] as const) {
    fake.post(ADMIN, fake.addThread(floor, { type, archived, name: `${type}-${archived ? 'archived' : 'active'}` }), { content: 'in a thread' });
  }

  ash = await signedIn(ASH);
  brock = await signedIn(BROCK).catch(() => browser(genie.url));
  gary = await signedIn(GARY);
  otherDayHeadJudge = await signedIn(OTHER);
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

describe('closing over HTTP', () => {
  it('lets the day’s head judge preflight and close, with the confirmations and refusals the routes promise', async () => {
    expect(ok(await ash.get(`/api/days/${dayId}/close`))).toEqual({ recentPenalties: [expect.objectContaining({ eventId: lcId })], csvBlocked: [], channels: 6 });
    expect((await otherDayHeadJudge.get(`/api/days/${dayId}/close`)).status).toBe(403);
    expect((await anonymous.get(`/api/days/${dayId}/close`)).status).toBe(401);
    const unconfirmed = await ash.post(`/api/days/${dayId}/close`, {});
    expect([unconfirmed.status, code(unconfirmed)]).toEqual([422, 'confirmation_required']);
    expect((await ash.post(`/api/days/${dayId}/close`, { confirm: 'yes' })).status).toBe(400);
    expect((await otherDayHeadJudge.post(`/api/days/${dayId}/close`, { confirm: true })).status).toBe(403);
    expect(ok(await ash.post(`/api/days/${dayId}/close`, { confirm: true }), 202)).toEqual({ jobId: expect.any(Number) as number });
    const again = await ash.post(`/api/days/${dayId}/close`, { confirm: true });
    expect(again.status).toBe(409);
    await dayState('closed');
    expect(code(await organizer.post(`/api/days/${dayId}/close`, { confirm: true }))).toBe('day_closed');
    expect(code(await organizer.put(`/api/days/${dayId}/staff`, { staff: [] }))).toBe('day_closed');
  });
});

describe('the exports, after close', () => {
  let view: Exports;
  beforeAll(async () => {
    view = ok(await organizer.get(`/api/days/${dayId}/exports`)) as Exports;
  });

  it('holds every channel and thread, the CSVs, and the attachment, each byte for byte', async () => {
    expect(view.transcripts.map((t) => t.name).sort()).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties', 'vgc-floor', 'vgc-penalties']);
    const floor = view.transcripts.find((t) => t.name === 'lc-floor')!;
    expect(floor.threads.map((t) => t.name).sort()).toEqual(['private-active', 'private-archived', 'public-active', 'public-archived']);
    const json = await organizer.get(`/api/exports/${floor.json.id}`);
    expect(sha(json.text)).toBe(floor.json.sha256);
    expect((JSON.parse(json.text) as { messages: unknown[] }).messages.length).toBeGreaterThan(120);
    const attachment = floor.attachments[0]!;
    expect(attachment).toMatchObject({ filename: EVIL, state: 'saved' });
    expect((await organizer.get(`/api/exports/${attachment.fileId}`)).text).toBe('attachment-bytes');
  });

  it('serves the HTML inline under the sandbox policy, and everything else as a download, never cached', async () => {
    const floor = view.transcripts.find((t) => t.name === 'lc-floor')!;
    const html = await organizer.get(`/api/exports/${floor.html.id}`);
    expect(html.status).toBe(200);
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-security-policy']).toBe(CSP_TRANSCRIPT);
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    expect(html.headers['x-frame-options']).toBe('DENY');
    expect(html.headers['referrer-policy']).toBe('no-referrer');
    expect(html.headers['cache-control']).toBe('no-store');
    expect(String(html.headers['content-disposition'])).toMatch(/^inline;/);

    const attachment = await organizer.get(`/api/exports/${floor.attachments[0]!.fileId}`);
    expect(attachment.headers['content-type']).toBe('application/octet-stream');
    expect(attachment.headers['content-disposition']).toBe(`attachment; filename="evil.html"; filename*=UTF-8''evil.html`);
    const json = await organizer.get(`/api/exports/${floor.json.id}`);
    expect(json.headers['content-type']).toBe('application/json');
    expect(String(json.headers['content-disposition'])).toMatch(/^attachment; filename="2026-10-17-lc-floor\.json"/);
    const csv = view.csvs.find((c) => c.eventId === lcId)!.files.find((f) => f.kind === 'penalties_csv')!;
    const csvReply = await organizer.get(`/api/exports/${csv.id}`);
    expect([csvReply.headers['content-type'], String(csvReply.headers['content-disposition'])]).toEqual(['text/csv; charset=utf-8', expect.stringMatching(/^attachment; filename="26-10-000123-penalties\.csv"/)]);
    expect(sha(csvReply.text)).toBe(csv.sha256);
    expect(csvReply.headers['cache-control']).toBe('no-store');
  });

  it('refuses a stored path that leaves the exports folder, without serving anything', async () => {
    const floor = view.transcripts.find((t) => t.name === 'lc-penalties')!;
    const db = new Database(genie.dataDir.databasePath);
    try {
      db.prepare("UPDATE export_file SET path = '../../app.db' WHERE id = ?").run(floor.json.id);
    } finally {
      db.close();
    }
    const reply = await organizer.get(`/api/exports/${floor.json.id}`);
    expect([reply.status, code(reply)]).toEqual([404, 'not_found']);
    expect(reply.text).not.toContain('SQLite format');
  });

  it('gives each head judge their event’s files only, and the same answer for files they may not see and files that don’t exist', async () => {
    const lcCsv = view.csvs.find((c) => c.eventId === lcId)!.files[0]!.id;
    const vgcCsv = view.csvs.find((c) => c.eventId === vgcId)!.files[0]!.id;
    const floor = view.transcripts.find((t) => t.name === 'lc-floor')!;
    const privateThread = floor.threads.find((t) => t.name === 'private-active')!.json.id;

    const asAsh = ok(await ash.get(`/api/days/${dayId}/exports`)) as Exports;
    expect(asAsh.organizer).toBeUndefined();
    expect(asAsh.csvs.map((c) => c.eventId)).toEqual([lcId]);
    expect(asAsh.transcripts.map((t) => t.name).sort()).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties']);
    expect(asAsh.transcripts.find((t) => t.name === 'lc-floor')!.threads.map((t) => t.name).sort()).toEqual(['public-active', 'public-archived']);
    expect((await ash.get(`/api/exports/${lcCsv}`)).status).toBe(200);
    for (const fileId of [vgcCsv, privateThread, 99_999_999]) {
      const refused = await ash.get(`/api/exports/${fileId}`);
      expect([refused.status, code(refused)], String(fileId)).toEqual([403, 'not_in_audience']);
    }
    expect((await gary.get(`/api/exports/${lcCsv}`)).status).toBe(403);
    expect((await gary.get(`/api/exports/${vgcCsv}`)).status).toBe(200);
    expect((await organizer.get('/api/exports/99999999')).status).toBe(404);
    expect((await otherDayHeadJudge.get(`/api/days/${dayId}/exports`)).status).toBe(403);
    expect((await anonymous.get(`/api/exports/${lcCsv}`)).status).toBe(401);
    expect((await brock.get(`/api/exports/${lcCsv}`)).status).toBeGreaterThanOrEqual(401);
    expectNoSecrets(replyTexts(ash));
  });

  it('keeps the organizer actions and the settings to organizers, with their refusals', async () => {
    for (const [method, path] of [
      ['post', `/api/days/${dayId}/purge`],
      ['post', `/api/days/${dayId}/reexport`],
      ['post', `/api/days/${dayId}/exports/attachments/retry`],
      ['post', `/api/days/${dayId}/exports/attachments/discard`],
      ['post', `/api/days/${dayId}/exports/csv`],
    ] as const) {
      expect((await ash[method](path, { confirm: true, attachmentIds: [1] })).status, path).toBe(403);
    }
    expect((await ash.put('/api/settings/close-out', { transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 25 })).status).toBe(403);
    expect(code(await organizer.post(`/api/days/${dayId}/exports/attachments/retry`, {}))).toBe('nothing_skipped');
    const discard = await organizer.post(`/api/days/${dayId}/exports/attachments/discard`, { attachmentIds: [1] });
    expect([discard.status, code(discard)]).toEqual([422, 'confirmation_required']);
    expect((await organizer.post(`/api/days/${dayId}/exports/attachments/discard`, { attachmentIds: [], confirm: true })).status).toBe(400);
    expect(code(await organizer.post(`/api/days/${dayId}/purge`, {}))).toBe('confirmation_required');

    const put = (s: Record<string, unknown>) => organizer.put('/api/settings/close-out', s);
    const base = { transcriptRetentionDays: 90, penaltyRetentionDays: 365, attachmentCapMb: 25 };
    expect(ok(await put(base))).toEqual({ ...base, purgeGraceHours: 168 });
    expect(code(await put({ ...base, transcriptRetentionDays: 7 }))).toBe('retention_not_longer_than_grace');
    for (const bad of [{ transcriptRetentionDays: 0 }, { penaltyRetentionDays: 3651 }, { attachmentCapMb: 0 }, { attachmentCapMb: 501 }, { attachmentCapMb: 1.5 }]) {
      expect((await put({ ...base, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    for (const fine of [{ penaltyRetentionDays: 1 }, { transcriptRetentionDays: 3650 }, { attachmentCapMb: 500 }, { attachmentCapMb: 1 }]) {
      expect((await put({ ...base, ...fine })).status, JSON.stringify(fine)).toBe(200);
    }
    ok(await put(base));
    expect((ok(await organizer.get('/api/settings')) as { closeOut: unknown }).closeOut).toEqual({ ...base, purgeGraceHours: 168 });
  });

  it('takes an organizer’s correction with a new CSV, and refuses a head judge’s', async () => {
    const { penalties } = ok(await ash.get(`/api/days/${dayId}/penalties`)) as { penalties: { id: number; revision: number }[] };
    const p = penalties[0]!;
    const refused = await ash.send(`/api/days/${dayId}/penalties/${p.id}`, { method: 'PATCH', json: { revision: p.revision, notes: 'Changed.' } });
    expect([refused.status, code(refused)]).toEqual([403, 'closed_organizer_only']);
    const corrected = ok(await organizer.send(`/api/days/${dayId}/penalties/${p.id}`, { method: 'PATCH', json: { revision: p.revision, notes: 'Corrected.' } })) as {
      penalty: { revision: number };
      exportFileId: number;
    };
    expect(corrected.penalty.revision).toBe(p.revision + 1);
    expect((await organizer.get(`/api/exports/${corrected.exportFileId}`)).text).toContain('Corrected.');
    const after = ok(await organizer.get(`/api/days/${dayId}/exports`)) as Exports;
    expect(after.csvs.find((c) => c.eventId === lcId)!.files.filter((f) => f.kind === 'penalties_csv' && f.supersededBy === null)).toHaveLength(1);
  });

  it('refuses the purge while an Administrator’s later post is unexported, then purges after a re-export', async () => {
    fake.post(ADMIN, channelId('vgc-floor'), { content: 'late' });
    ok(await organizer.post(`/api/days/${dayId}/purge`, { confirm: true }), 202);
    await dayStateAfterJob('purge');
    const status = ok(await organizer.get('/api/status')) as { alarms: { kind: string; dayId: number }[] };
    expect(status.alarms).toContainEqual(expect.objectContaining({ kind: 'purge_refused', dayId }));
    ok(await organizer.post(`/api/days/${dayId}/reexport`, {}), 202);
    await dayState('purged');
    const left = [...fake.channels.values()].filter((c) => c.guildId === IDS.guild);
    expect(left).toEqual([]);
    expect((ok(await organizer.get('/api/status')) as { alarms: { kind: string }[] }).alarms).toEqual([]);
    expect((await ash.get(`/api/exports/${view.csvs[0]!.files[0]!.id}`)).status).toBe(403);
  });
});

/** Waits until the day's newest job of a kind has finished. */
async function dayStateAfterJob(kind: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { latestJob } = ok(await organizer.get(`/api/days/${dayId}`)) as { latestJob: { state: string; kind: string } | null };
    if (latestJob?.kind === kind && latestJob.state !== 'queued' && latestJob.state !== 'running') return;
    if (Date.now() > deadline) throw new Error(`no finished ${kind}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
