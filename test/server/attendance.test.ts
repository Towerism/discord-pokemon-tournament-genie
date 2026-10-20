import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RECORDED_FIXTURE_PATH } from '../contract/attendance-source';
import { IDS, storeWorld } from '../support/discord-world';
import { type FakeAttendanceHttp, startFakeAttendanceHttp } from '../support/fake-attendance-http';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { completeSetup, expectNoSecrets, loginThroughDiscord, replyTexts } from '../support/flows';
import { type Genie, startGenie } from '../support/genie-process';
import { type Browser, type Reply, browser } from '../support/http-client';

const ASH = '100000000000000101';
const TOKEN = `ppa_int_${'k'.repeat(31)}SeCrEtToKeN9`;
const NEW_TOKEN = `ppa_int_${'n'.repeat(31)}AnOtHeRtOk3n`;
const XSS = '<img src=x onerror=alert(1)>';
const FIXTURE_DATE = '2026-10-14';

let attendance: FakeAttendanceHttp;
let discord: FakeDiscordHttp;
let genie: Genie;
let owner: Browser;
let organizer: Browser;
let headJudge: Browser;
let anonymous: Browser;
let hjDayId: number;

const ok = (r: Reply, status = 200) => {
  expect(r.status, r.text).toBe(status);
  return r.json<Record<string, unknown>>();
};
const code = (r: Reply) => (r.json<{ data?: { code?: string } }>().data?.code ?? '') as string;
const del = (b: Browser, path: string) => b.send(path, { method: 'DELETE' });
const putConnection = (b: Browser, json: unknown) => b.put('/api/settings/attendance', json);

async function signedIn(userId: string): Promise<Browser> {
  const b = browser(genie.url);
  expect((await loginThroughDiscord(b, discord, userId)).location).toBe('/');
  return b;
}

async function newDay(date: string): Promise<number> {
  return (ok(await organizer.post('/api/days', { date, title: `Day ${date}` }), 201) as { day: { id: number } }).day.id;
}

type Pulled = { snapshotId: string; planRevision: number; diff: { items: { key: string }[]; unreadProfessors: unknown[] } };
async function importAll(dayId: number) {
  const pulled = ok(await organizer.post(`/api/days/${dayId}/import`)) as Pulled;
  return ok(
    await organizer.post(`/api/days/${dayId}/import/accept`, {
      snapshotId: pulled.snapshotId,
      planRevision: pulled.planRevision,
      keys: pulled.diff.items.map((i) => i.key),
    }),
  ) as { plan: { events: Record<string, unknown>[]; staff: Record<string, unknown>[]; day: { attendance: unknown } }; applied: number; syncJobId: number | null };
}

beforeAll(async () => {
  attendance = await startFakeAttendanceHttp({ token: TOKEN });
  attendance.raw.set(FIXTURE_DATE, JSON.parse(readFileSync(RECORDED_FIXTURE_PATH, 'utf8')));
  const fake = storeWorld();
  fake.addMember(IDS.guild, ASH, [], { displayName: 'Ash Ketchum', username: 'ash' });
  discord = await startFakeDiscordHttp(fake);
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000' } });
  owner = browser(genie.url);
  anonymous = browser(genie.url);
  await completeSetup(owner, genie, discord);
  organizer = await signedIn(IDS.organizer);

  // A head judge, so the matrix has a signed-in non-organizer.
  const ash = ok(await organizer.post('/api/staff', { displayName: 'Ash', discordUserId: ASH }), 201) as { id: number };
  hjDayId = await newDay('2026-10-24');
  const lc = ok(await organizer.post(`/api/days/${hjDayId}/events`, { name: 'LC', game: 'tcg', startTime: '10:00' }), 201) as { id: number };
  ok(await organizer.put(`/api/days/${hjDayId}/staff`, { staff: [{ staffMemberId: ash.id, events: [{ eventId: lc.id, role: 'headjudge' }] }] }));
  headJudge = await signedIn(ASH);
}, 120_000);

afterAll(async () => {
  await genie?.stop();
  await discord?.close();
  await attendance?.close();
});

describe('the attendance connection', () => {
  it('stores the address and a hint, never answers the token, and needs the token again for a new address', async () => {
    expect(ok(await organizer.get('/api/settings/attendance'))).toEqual({
      configured: false,
      delivery: { state: 'off', since: null, lastPollAt: null, lastResultAt: null },
    });
    expect(code(await putConnection(organizer, { baseUrl: `${attendance.url}/` }))).toBe('token_required');

    const saved = ok(await putConnection(organizer, { baseUrl: `${attendance.url}/`, token: TOKEN }));
    expect(saved).toEqual({ configured: true, baseUrl: attendance.url, tokenHint: `ppa_int_…${TOKEN.slice(-4)}`, updatedAt: expect.any(Number) });

    expect(ok(await putConnection(organizer, { baseUrl: attendance.url }))).toMatchObject({ baseUrl: attendance.url });

    const moved = await putConnection(organizer, { baseUrl: 'http://127.0.0.1:9' });
    expect([moved.status, code(moved)]).toEqual([422, 'token_required']);
    expect(ok(await organizer.get('/api/settings/attendance'))).toMatchObject({ baseUrl: attendance.url });
  });

  it('says whether Genie delivers attendance’s messages, without the token or any message', async () => {
    ok(await putConnection(organizer, { baseUrl: attendance.url, token: TOKEN }));
    // The built app's fake Discord has no gateway, so the bot never connects and Genie doesn't poll.
    await expect.poll(async () => (ok(await organizer.get('/api/settings/attendance')) as { delivery: { state: string } }).delivery.state).toBe('waiting_for_bot');
    const body = JSON.stringify(ok(await organizer.get('/api/settings/attendance')));
    expect(body).not.toContain(TOKEN);
    expect(attendance.polls).toHaveLength(0);
  });

  it('refuses the secret from an address that isn’t allowed', async () => {
    const lan = browser(genie.url, { host: `192.168.1.5:${genie.port}` });
    const res = await putConnection(lan, { baseUrl: attendance.url, token: TOKEN });
    expect([res.status, code(res)]).toEqual([403, 'insecure_origin']);
  });

  it.each([
    ['ftp://attendance'],
    ['http://u:p@attendance'],
    ['http://attendance/?q=1'],
    ['http://attendance/#x'],
    ['not a url'],
    [`http://attendance/${'a'.repeat(2048)}`],
  ])('refuses the base URL %s', async (baseUrl) => {
    const res = await putConnection(organizer, { baseUrl, token: TOKEN });
    expect([res.status, code(res)]).toEqual([400, 'invalid_body']);
  });

  it.each([[{}], [{ token: TOKEN }], [{ baseUrl: 5, token: TOKEN }], [{ baseUrl: 'http://a', token: 'ppa_int_short' }], [{ baseUrl: 'http://a', token: TOKEN, extra: 1 }]])(
    'refuses the body %j',
    async (json) => {
      const res = await putConnection(organizer, json);
      expect([res.status, code(res)]).toEqual([400, 'invalid_body']);
      expect(res.json<{ data: { issues: unknown[] } }>().data.issues.length).toBeGreaterThan(0);
    },
  );
});

describe('importing a day', () => {
  it('brings in every tournament of the recorded fixture with its organizer and staff', async () => {
    const dayId = await newDay(FIXTURE_DATE);
    const { plan, applied } = await importAll(dayId);

    expect(applied).toBe(2);
    expect(plan.events.map((e) => [e.name, e.game, e.startTime, e.tournamentId, e.attendance])).toEqual([
      ['Brock Cup', 'vgc', '17:00', '26-10-000002', { tournamentId: 'brocks', organizerPlayerId: '0000222', organizerName: 'Brock Harrison' }],
      ['Olive Cup', 'tcg', '18:30', '26-10-000001', { tournamentId: 'olives', organizerPlayerId: '9999991', organizerName: 'Olive Oak' }],
    ]);
    expect(plan.staff.map((s) => [s.displayName, s.linkState])).toEqual([
      ['Ash Ketchum', 'unlinked'],
      ['Misty Waterflower', 'unlinked'],
    ]);
    expect(plan.day.attendance).toEqual({ source: 'attendance', refreshedAt: expect.any(Number) });
    expect(ok(await organizer.get(`/api/days/${dayId}`))).toMatchObject({ day: { attendance: { source: 'attendance' } } });
    expect(attendance.requests.at(-1)).toEqual({ path: `/api/integrations/v1/days/${FIXTURE_DATE}`, authorization: true, tokenMatched: true });
  });

  it('refuses, leaving the plan as it was, when attendance can’t be used', async () => {
    const date = '2026-10-31';
    const dayId = await newDay(date);
    const before = ok(await organizer.get(`/api/days/${dayId}`));
    const pull = () => organizer.post(`/api/days/${dayId}/import`);

    attendance.raw.set(date, { date, timezone: 'Europe/London', tournaments: [], professors: [] });
    const zone = await pull();
    expect([zone.status, zone.json()]).toEqual([
      422,
      expect.objectContaining({ data: { code: 'timezone_mismatch', attendanceTimeZone: 'Europe/London', genieTimeZone: 'America/Chicago' } }),
    ]);

    attendance.raw.set(date, { date, timezone: 'America/Chicago', tournaments: [], professors: [] });
    expect([(await pull()).status, code(await pull())]).toEqual([422, 'no_connected_organizers']);

    attendance.token = NEW_TOKEN;
    const refused = await pull();
    expect([refused.status, code(refused)]).toEqual([502, 'attendance_token_rejected']);
    attendance.token = TOKEN;

    attendance.next({ kind: 'server_error' });
    const down = await pull();
    expect([down.status, code(down)]).toEqual([503, 'attendance_unavailable']);

    attendance.next({ kind: 'rate_limited', retryAfter: '12' });
    const limited = await pull();
    expect([limited.status, limited.json<{ data: unknown }>().data]).toEqual([503, { code: 'attendance_rate_limited', retryAfterSeconds: 12 }]);

    expect((await del(organizer, '/api/settings/attendance')).status).toBe(204);
    const none = await pull();
    expect([none.status, code(none)]).toEqual([409, 'attendance_not_configured']);
    ok(await putConnection(organizer, { baseUrl: attendance.url, token: TOKEN }));

    expect(ok(await organizer.get(`/api/days/${dayId}`))).toEqual(before);
  });

  it('stores and answers names verbatim', async () => {
    const date = '2026-11-07';
    const dayId = await newDay(date);
    attendance.raw.set(date, {
      date,
      timezone: 'America/Chicago',
      tournaments: [
        { id: 'x', name: XSS, displayId: null, startsAt: '2026-11-07T16:00:00.000Z', game: 'tcg', organizer: { playerId: '1', name: XSS }, staff: [{ playerId: '4242', name: XSS, role: 'judge' }] },
      ],
      professors: [{ playerId: '1', name: XSS, status: 'read' }],
    });
    const { plan } = await importAll(dayId);
    expect(plan.events[0]).toMatchObject({ name: XSS, attendance: { organizerName: XSS } });
    expect(plan.staff[0]).toMatchObject({ displayName: XSS });
  });
});

describe('who may import', () => {
  it.each([
    ['POST', () => `/api/days/${hjDayId}/import`, undefined],
    ['POST', () => `/api/days/${hjDayId}/import/accept`, { snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 1, keys: [] }],
    ['GET', () => '/api/settings/attendance', undefined],
    ['PUT', () => '/api/settings/attendance', { baseUrl: 'http://a', token: TOKEN }],
    ['DELETE', () => '/api/settings/attendance', undefined],
  ])('%s %s: no session 401, a head judge of the day 403', async (method, path, json) => {
    const anon = await anonymous.send(path(), { method, json });
    expect([anon.status, code(anon)]).toEqual([401, 'unauthenticated']);
    const hj = await headJudge.send(path(), { method, json });
    expect([hj.status, code(hj)]).toEqual([403, 'forbidden']);
  });

  it.each([
    [{}],
    [{ snapshotId: 'not-a-uuid', planRevision: 1, keys: [] }],
    [{ snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 0, keys: [] }],
    [{ snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: '1', keys: [] }],
    [{ snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 1, keys: Array.from({ length: 2001 }, (_, i) => `k${i}`) }],
    [{ snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 1, keys: ['k'.repeat(65)] }],
    [{ snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 1 }],
  ])('refuses the accept body %#', async (json) => {
    const res = await organizer.post(`/api/days/${hjDayId}/import/accept`, json);
    expect([res.status, code(res)]).toEqual([400, 'invalid_body']);
  });

  it('answers an organizer, and a stale accept is refused, not applied', async () => {
    const res = await organizer.post(`/api/days/${hjDayId}/import/accept`, { snapshotId: '00000000-0000-4000-8000-000000000000', planRevision: 1, keys: [] });
    expect([res.status, code(res)]).toEqual([409, 'snapshot_stale']);
  });
});

describe('secrets', () => {
  it('never answers or logs the attendance token, which attendance did receive', () => {
    const texts = [owner, organizer, headJudge, anonymous].flatMap(replyTexts);
    for (const text of [...texts, genie.log()]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(NEW_TOKEN);
    }
    expectNoSecrets([...texts, genie.log()]);
    expect(attendance.requests.some((r) => r.tokenMatched)).toBe(true);
  });
});
