import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { PERMISSION_BITS as P } from '../../shared/discord/permissions';
import { IDS, storeWorld } from '../support/discord-world';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { completeSetup, expectNoSecrets, loginThroughDiscord, replyTexts } from '../support/flows';
import { type Genie, startGenie } from '../support/genie-process';
import { type Browser, type Reply, browser } from '../support/http-client';

const ASH = '100000000000000101';
const BROCK = '100000000000000102';
const MISTY = '100000000000000103';
const ASHLEY = '100000000000000104';
const ASHBOT = '100000000000000105';
const GARY = '100000000000000106';
const CHANNELS = ['day-staff', 'head-judges', 'lc-floor', 'lc-penalties', 'vgc-floor', 'vgc-penalties'];
const XSS = '<img src=x onerror=alert(1)>';

let fake: FakeDiscord;
let discord: FakeDiscordHttp;
let genie: Genie;
let owner: Browser;
let organizer: Browser;
let headJudge: Browser;
let otherHeadJudge: Browser;
let anonymous: Browser;
let dayId: number;
let otherDayId: number;
let lcId: number;
let vgcId: number;
let openJobId: number;

const patch = (b: Browser, path: string, json: unknown) => b.send(path, { method: 'PATCH', json });
const del = (b: Browser, path: string) => b.send(path, { method: 'DELETE' });
const ok = (r: Reply, status = 200) => {
  expect(r.status, r.text).toBe(status);
  return r.json<Record<string, unknown>>();
};

/** Polls the job through the API until it ends (no fixed sleeps, a bounded deadline). */
async function finished(b: Browser, jobId: number) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { job } = ok(await b.get(`/api/jobs/${jobId}`)) as { job: { state: string; error: string | null } };
    if (['succeeded', 'failed', 'interrupted'].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function signedIn(userId: string): Promise<Browser> {
  const b = browser(genie.url);
  const res = await loginThroughDiscord(b, discord, userId);
  expect(res.location).toBe('/');
  return b;
}

beforeAll(async () => {
  fake = storeWorld();
  fake.guilds.get(IDS.guild)!.ownerId = IDS.owner;
  fake.addMember(IDS.guild, ASH, [], { displayName: 'Ash Ketchum', username: 'ash' });
  fake.addMember(IDS.guild, BROCK, [], { displayName: 'Brock', username: 'brock' });
  fake.addMember(IDS.guild, MISTY, [], { displayName: 'Misty', username: 'misty' });
  fake.addMember(IDS.guild, ASHLEY, [], { displayName: 'Ashley', username: 'ashley' });
  fake.addMember(IDS.guild, ASHBOT, [], { displayName: 'Ashbot', username: 'ashbot', bot: true });
  fake.addMember(IDS.guild, GARY, [], { displayName: 'Gary', username: 'gary' });
  fake.guilds.get(IDS.guild)!.roles[0]!.permissions = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
  discord = await startFakeDiscordHttp(fake);
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000' } });
  owner = browser(genie.url);
  anonymous = browser(genie.url);
  await completeSetup(owner, genie, discord);
  organizer = await signedIn(IDS.organizer);

  // The plan, through the API: staff, a day, two events, roles.
  const ash = ok(await organizer.post('/api/staff', { displayName: 'Ash', discordUserId: ASH }), 201) as { id: number };
  const brock = ok(await organizer.post('/api/staff', { displayName: 'Brock', discordUserId: BROCK }), 201) as { id: number };
  const misty = ok(await organizer.post('/api/staff', { displayName: 'Misty', discordUserId: MISTY }), 201) as { id: number };
  const plan = ok(await organizer.post('/api/days', { date: '2026-10-17', title: 'October LC' }), 201) as { day: { id: number } };
  dayId = plan.day.id;
  lcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'LC', game: 'tcg', startTime: '10:00' }), 201) as { id: number }).id;
  vgcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'VGC', game: 'vgc', startTime: '11:30' }), 201) as { id: number }).id;
  ok(
    await organizer.put(`/api/days/${dayId}/staff`, {
      staff: [
        { staffMemberId: ash.id, events: [{ eventId: lcId, role: 'headjudge' }] },
        { staffMemberId: brock.id, events: [{ eventId: lcId, role: 'judge' }] },
        { staffMemberId: misty.id, events: [{ eventId: vgcId, role: 'judge' }] },
      ],
    }),
  );
  // Another day, head-judged by Gary.
  const gary = ok(await organizer.post('/api/staff', { displayName: 'Gary', discordUserId: GARY }), 201) as { id: number };
  otherDayId = (ok(await organizer.post('/api/days', { date: '2026-10-18', title: 'Other' }), 201) as { day: { id: number } }).day.id;
  const otherEvent = (ok(await organizer.post(`/api/days/${otherDayId}/events`, { name: 'GO', game: 'go', startTime: '09:00' }), 201) as { id: number }).id;
  ok(await organizer.put(`/api/days/${otherDayId}/staff`, { staff: [{ staffMemberId: gary.id, events: [{ eventId: otherEvent, role: 'headjudge' }] }] }));

  headJudge = await signedIn(ASH);
  otherHeadJudge = await signedIn(GARY);
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

describe('plan → open, end to end', () => {
  it('opens the day: the fake holds the category and six channels, and the plan is in sync', async () => {
    const started = Date.now();
    const opened = ok(await organizer.post(`/api/days/${dayId}/open`), 202) as { jobId: number };
    openJobId = opened.jobId;
    const job = await finished(organizer, openJobId);
    expect(job, JSON.stringify(job)).toMatchObject({ state: 'succeeded' });
    console.info(`[perf] open of a 6-channel day took ${Date.now() - started} ms through the HTTP fake`);

    const category = [...fake.channels.values()].find((c) => c.name === '🏆 Sat Oct 17 · October LC')!;
    expect([...fake.channels.values()].filter((c) => c.parentId === category.id).map((c) => c.name)).toEqual(CHANNELS);
    const floor = [...fake.channels.values()].find((c) => c.name === 'lc-floor')!;
    const viewers = [...fake.guilds.get(IDS.guild)!.members.keys()].filter((u) => fake.permissionsFor(u, floor.id) & P.ViewChannel);
    expect(viewers).toContain(ASH);
    expect(viewers).toContain(BROCK);
    expect(viewers).not.toContain(MISTY);
    const plan = ok(await organizer.get(`/api/days/${dayId}`)) as { sync: { inSync: boolean }; day: { state: string }; channels: unknown[] };
    expect(plan.day.state).toBe('open');
    expect(plan.sync.inSync).toBe(true);
    expect(plan.channels).toHaveLength(6);
  });

  it('streams a finished job’s events, and resumes after Last-Event-ID', async () => {
    const persisted = (ok(await organizer.get(`/api/jobs/${openJobId}`)) as { events: { id: number }[] }).events;
    const stream = await organizer.get(`/api/jobs/${openJobId}/events`);
    expect(stream.headers['content-type']).toMatch(/text\/event-stream/);
    const ids = [...stream.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual(persisted.map((e) => e.id));
    const resumed = await organizer.get(`/api/jobs/${openJobId}/events`, { headers: { 'last-event-id': String(ids[2]) } });
    expect([...resumed.text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual(ids.slice(3));
  });
});

describe('head judges on the website', () => {
  it('log in with an audited event_head_judge grant and find their day in /api/me', async () => {
    const me = ok(await headJudge.get('/api/me')) as { grant: string; headJudgeDays: { id: number }[] };
    expect(me.grant).toBe('event_head_judge');
    expect(me.headJudgeDays.map((d) => d.id)).toEqual([dayId]);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(genie.dataDir.databasePath, { readonly: true });
    expect(db.prepare("select count(*) as n from login_audit where discord_user_id = ? and \"grant\" = 'event_head_judge'").get(ASH)).toEqual({ n: 1 });
    db.close();
  });

  it('read and sync their day, and nothing else', async () => {
    expect((await headJudge.get(`/api/days/${dayId}`)).status).toBe(200);
    expect((await headJudge.post(`/api/days/${dayId}/sync`)).status).toBe(202);
    expect((await headJudge.get('/api/days')).status).toBe(403);
    expect((await headJudge.get(`/api/days/${otherDayId}`)).status).toBe(403);
    expect((await patch(headJudge, `/api/days/${dayId}`, { title: 'Mine' })).status).toBe(403);
    expect((await headJudge.get('/api/staff')).status).toBe(403);
    expect((await headJudge.get('/api/blueprints')).status).toBe(403);
    expect((await headJudge.get('/api/status')).status).toBe(403);
  });

  it('refuses a plain judge at login', async () => {
    const judge = browser(genie.url);
    expect((await loginThroughDiscord(judge, discord, BROCK)).location).toBe('/login?error=no_access');
  });
});

describe('the preview', () => {
  it('shows the organizer every channel and LC’s head judge only theirs', async () => {
    const all = ok(await organizer.get(`/api/days/${dayId}/preview`)) as { channels: { name: string; audience: { displayName: string }[] }[] };
    expect(all.channels.map((c) => c.name)).toEqual(CHANNELS);
    expect(all.channels.find((c) => c.name === 'lc-floor')!.audience.map((a) => a.displayName)).toEqual(['Ash', 'Brock']);
    const mine = ok(await headJudge.get(`/api/days/${dayId}/preview`)) as { channels: { name: string }[] };
    expect(mine.channels.map((c) => c.name)).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties']);
    expect((await otherHeadJudge.get(`/api/days/${dayId}/preview`)).status).toBe(403);
  });

  it('still answers with Discord down', async () => {
    const started = Date.now();
    fake.unavailable = true;
    try {
      const down = ok(await organizer.get(`/api/days/${otherDayId}/preview`)) as { headJudgeRole: string };
      expect(down.headJudgeRole).toBe('unavailable');
    } finally {
      fake.unavailable = false;
    }
    console.info(`[perf] preview with Discord down took ${Date.now() - started} ms`);
  });
});

describe('streaming staff', () => {
  it('are planned like any role, and the preview keeps them out of the day, floor and penalties channels', async () => {
    const { staff } = ok(await organizer.get('/api/staff')) as { staff: { id: number; displayName: string }[] };
    const id = (name: string) => staff.find((s) => s.displayName === name)!.id;
    const day = (ok(await organizer.post('/api/days', { date: '2026-10-19', title: 'Stream' }), 201) as { day: { id: number } }).day.id;
    const cup = (ok(await organizer.post(`/api/days/${day}/events`, { name: 'Cup', game: 'vgc', startTime: '10:00' }), 201) as { id: number }).id;
    ok(
      await organizer.put(`/api/days/${day}/staff`, {
        staff: [
          { staffMemberId: id('Misty'), events: [{ eventId: cup, role: 'streaming' }] },
          { staffMemberId: id('Brock'), events: [{ eventId: cup, role: 'judge' }] },
        ],
      }),
    );
    const plan = ok(await organizer.get(`/api/days/${day}`)) as { staff: { staffMemberId: number; events: { eventId: number; role: string }[] }[] };
    expect(plan.staff.find((s) => s.staffMemberId === id('Misty'))!.events).toEqual([{ eventId: cup, role: 'streaming' }]);
    const preview = ok(await organizer.get(`/api/days/${day}/preview`)) as { channels: { name: string; audience: { displayName: string }[] }[] };
    for (const name of ['day-staff', 'cup-floor', 'cup-penalties']) {
      expect(preview.channels.find((c) => c.name === name)!.audience.map((a) => a.displayName), name).toEqual(['Brock']);
    }
  });

  it('get blueprint channels of their own, never a penalties one', async () => {
    const channel = (key: string, scope: string, audience: string, purpose: string) => ({
      key,
      scope,
      kind: 'text',
      namePattern: scope === 'day' ? key : `{slug}-${key}`,
      audience,
      purpose,
      topic: null,
      position: 0,
    });
    const created = ok(
      await organizer.post('/api/blueprints', { name: 'With stream', categoryNamePattern: '{title}', channels: [channel('stream', 'day', 'streaming', 'general'), channel('cam', 'per_event', 'streaming', 'floor')] }),
      201,
    ) as { id: number };
    const { blueprints } = ok(await organizer.get('/api/blueprints')) as { blueprints: { id: number; channels: { key: string; audience: string }[] }[] };
    expect(blueprints.find((b) => b.id === created.id)!.channels.map((c) => [c.key, c.audience]).sort()).toEqual([
      ['cam', 'streaming'],
      ['stream', 'streaming'],
    ]);
    for (const scope of ['day', 'per_event']) {
      const refused = await organizer.post('/api/blueprints', { name: `Bad ${scope}`, categoryNamePattern: '{title}', channels: [channel('p', scope, 'streaming', 'penalties')] });
      expect(refused.status, refused.text).toBe(422);
      expect(refused.json()).toMatchObject({ data: { code: 'invalid_blueprint', problems: [{ path: 'channels.0.audience', code: 'audience_not_allowed' }] } });
    }
  });
});

describe('editing a staff member', () => {
  // Its own members and draft day: the suite's opened day is read by later tests, and an edit must not queue a sync there.
  const KEN = '100000000000000201';

  it('changes only the name and player ID, clears the player ID, and shows the change on a day', async () => {
    const ken = ok(await organizer.post('/api/staff', { displayName: 'Ken', discordUserId: KEN, playerId: '0028010' }), 201) as { id: number };
    const { day } = ok(await organizer.post('/api/days', { date: '2026-11-07', title: 'Edit Saturday' }), 201) as { day: { id: number } };
    const event = ok(await organizer.post(`/api/days/${day.id}/events`, { name: 'LC', game: 'tcg', startTime: '10:00' }), 201) as { id: number };
    ok(await organizer.put(`/api/days/${day.id}/staff`, { staff: [{ staffMemberId: ken.id, events: [{ eventId: event.id, role: 'judge' }] }] }));
    const unchanged = { discordUserId: KEN, linkState: 'linked', claimedDiscordUserId: null };

    const edited = ok(await patch(organizer, `/api/staff/${ken.id}`, { displayName: '  Kenji  ', playerId: '0028011' }));
    expect(edited).toEqual({ staff: { id: ken.id, displayName: 'Kenji', playerId: '0028011', ...unchanged }, syncJobIds: [] });
    const cleared = ok(await patch(organizer, `/api/staff/${ken.id}`, { playerId: null }));
    expect(cleared).toEqual({ staff: { id: ken.id, displayName: 'Kenji', playerId: null, ...unchanged }, syncJobIds: [] });
    // Saving the same values again is a no-op.
    expect(ok(await patch(organizer, `/api/staff/${ken.id}`, { displayName: 'Kenji', playerId: null }))).toEqual(cleared);

    const plan = ok(await organizer.get(`/api/days/${day.id}`)) as { staff: { staffMemberId: number; displayName: string }[] };
    expect(plan.staff).toEqual([expect.objectContaining({ staffMemberId: ken.id, displayName: 'Kenji' })]);
  });

  it('refuses another member’s player ID and keeps a member’s own', async () => {
    const a = ok(await organizer.post('/api/staff', { displayName: 'Holder A', playerId: '0028012' }), 201) as { id: number };
    const b = ok(await organizer.post('/api/staff', { displayName: 'Holder B', playerId: '0028013' }), 201) as { id: number };
    const taken = await patch(organizer, `/api/staff/${b.id}`, { playerId: '0028012' });
    expect(taken.status).toBe(409);
    expect(taken.json()).toMatchObject({ data: { code: 'player_id_taken' } });
    const listed = ok(await organizer.get('/api/staff')) as { staff: { id: number; playerId: string | null }[] };
    expect(listed.staff.find((s) => s.id === b.id)?.playerId).toBe('0028013');
    expect((ok(await patch(organizer, `/api/staff/${a.id}`, { playerId: '0028012' })) as { staff: { playerId: string } }).staff.playerId).toBe('0028012');
  });

  it('accepts a 64-character name and a 10-digit player ID, as sent', async () => {
    const m = ok(await organizer.post('/api/staff', { displayName: 'Boundary' }), 201) as { id: number };
    const name = 'x'.repeat(64);
    const { staff } = ok(await patch(organizer, `/api/staff/${m.id}`, { displayName: name, playerId: '1234567890' })) as { staff: { displayName: string; playerId: string } };
    expect(staff).toMatchObject({ displayName: name, playerId: '1234567890' });
  });
});

describe('the member picker', () => {
  it('finds humans by name with their staff link, and refuses bad queries', async () => {
    const found = ok(await organizer.get('/api/discord/members?q=ash')) as { members: { userId: string; staffMemberId: number | null }[] };
    expect(found.members.map((m) => m.userId).sort()).toEqual([ASH, ASHLEY].sort());
    expect(found.members.find((m) => m.userId === ASH)!.staffMemberId).not.toBeNull();
    expect(found.members.find((m) => m.userId === ASHLEY)!.staffMemberId).toBeNull();
    expect((await organizer.get('/api/discord/members?q=')).status).toBe(400);
    expect((await organizer.get(`/api/discord/members?q=${'a'.repeat(33)}`)).status).toBe(400);
    fake.unavailable = true;
    try {
      expect((await organizer.get('/api/discord/members?q=ash')).json()).toMatchObject({ data: { code: 'discord_unavailable' } });
    } finally {
      fake.unavailable = false;
    }
  });
});

describe('orphans', () => {
  it('refuses to adopt over a present channel, and deletes an orphan', async () => {
    const plan = ok(await organizer.get(`/api/days/${dayId}`)) as { day: { categoryId: string } };
    const orphan = await fake.create('fake-bot-token-0123456789').gateway.createChannel(IDS.guild, { name: 'random', parentId: plan.day.categoryId, overwrites: [] });
    await finished(organizer, (ok(await organizer.post(`/api/days/${dayId}/sync`), 202) as { jobId: number }).jobId);
    const adopt = await organizer.post(`/api/days/${dayId}/orphans/${orphan}/adopt`, { key: 'floor', eventId: lcId });
    expect(adopt.status).toBe(409);
    expect(adopt.json()).toMatchObject({ data: { code: 'already_provisioned' } });
    const after = ok(await organizer.post(`/api/days/${dayId}/orphans/${orphan}/delete`)) as { orphans: unknown[] };
    expect(after.orphans).toEqual([]);
    expect(fake.channels.has(orphan)).toBe(false);
    expect((await organizer.post(`/api/days/${dayId}/orphans/${orphan}/delete`)).status).toBe(404);
  });
});

describe('every M2 route', () => {
  const day = () => `/api/days/${dayId}`;
  const routes = (): { method: string; path: string; scope: 'install' | 'day'; body?: unknown }[] => [
    { method: 'GET', path: '/api/staff', scope: 'install' },
    { method: 'POST', path: '/api/staff', scope: 'install', body: { displayName: 'X' } },
    { method: 'PATCH', path: '/api/staff/1', scope: 'install', body: { displayName: 'X' } },
    { method: 'POST', path: '/api/staff/1/confirm-claim', scope: 'install' },
    { method: 'POST', path: '/api/staff/1/reject-claim', scope: 'install' },
    { method: 'GET', path: '/api/discord/members?q=a', scope: 'install' },
    { method: 'GET', path: '/api/blueprints', scope: 'install' },
    { method: 'POST', path: '/api/blueprints', scope: 'install', body: {} },
    { method: 'PUT', path: '/api/blueprints/1', scope: 'install', body: {} },
    { method: 'DELETE', path: '/api/blueprints/1', scope: 'install' },
    { method: 'GET', path: '/api/templates', scope: 'install' },
    { method: 'POST', path: '/api/templates', scope: 'install', body: {} },
    { method: 'PUT', path: '/api/templates/1', scope: 'install', body: {} },
    { method: 'DELETE', path: '/api/templates/1', scope: 'install' },
    { method: 'GET', path: '/api/days', scope: 'install' },
    { method: 'POST', path: '/api/days', scope: 'install', body: {} },
    { method: 'GET', path: day(), scope: 'day' },
    { method: 'PATCH', path: day(), scope: 'day', body: {} },
    { method: 'DELETE', path: day(), scope: 'day' },
    { method: 'POST', path: `${day()}/events`, scope: 'day', body: {} },
    { method: 'PATCH', path: `${day()}/events/${lcId}`, scope: 'day', body: {} },
    { method: 'DELETE', path: `${day()}/events/${lcId}`, scope: 'day' },
    { method: 'PUT', path: `${day()}/staff`, scope: 'day', body: {} },
    { method: 'GET', path: `${day()}/preview`, scope: 'day' },
    { method: 'POST', path: `${day()}/open`, scope: 'day' },
    { method: 'POST', path: `${day()}/sync`, scope: 'day' },
    { method: 'POST', path: `${day()}/orphans/1/adopt`, scope: 'day', body: {} },
    { method: 'POST', path: `${day()}/orphans/1/delete`, scope: 'day' },
    { method: 'GET', path: `/api/jobs/${openJobId}`, scope: 'day' },
    { method: 'GET', path: `/api/jobs/${openJobId}/events`, scope: 'day' },
  ];
  const call = (b: Browser, r: { method: string; path: string; body?: unknown }) => b.send(r.path, { method: r.method, ...(r.body === undefined ? {} : { json: r.body }) });

  it('answers 401 without a session and 403 to a head judge of another day, with an error body', async () => {
    for (const r of routes()) {
      const unauth = await call(anonymous, r);
      expect(unauth.status, `${r.method} ${r.path}`).toBe(401);
      expect(unauth.json(), `${r.method} ${r.path}`).toMatchObject({ data: { code: 'unauthenticated' } });
      const other = await call(otherHeadJudge, r);
      expect(other.status, `${r.method} ${r.path} as another day's head judge`).toBe(403);
      expect(other.json(), `${r.method} ${r.path}`).toMatchObject({ data: { code: 'forbidden' } });
    }
  });

  it('lets this day’s head judge read, preview, sync and follow jobs, and nothing more', async () => {
    const allowed = new Set([`GET ${day()}`, `GET ${day()}/preview`, `POST ${day()}/sync`, `GET /api/jobs/${openJobId}`, `GET /api/jobs/${openJobId}/events`]);
    for (const r of routes()) {
      const res = await call(headJudge, r);
      if (allowed.has(`${r.method} ${r.path}`)) expect(res.status, `${r.method} ${r.path}`).toBeLessThan(300);
      else expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('lets an organizer through every route: never 401 or 403, never a 500', async () => {
    for (const r of routes().filter((x) => x.method === 'GET')) {
      const res = await call(organizer, r);
      expect(res.status, `${r.method} ${r.path}`).toBeLessThan(300);
    }
    // Writes with empty bodies are refused by validation or the day's state, never by authorization.
    for (const r of routes().filter((x) => x.method !== 'GET' && !(x.method === 'DELETE' && x.path === day()))) {
      const res = await call(organizer, r);
      expect([401, 403], `${r.method} ${r.path}: ${res.text}`).not.toContain(res.status);
      expect(res.status, `${r.method} ${r.path}: ${res.text}`).toBeLessThan(500);
    }
    expect(ok(await organizer.get('/api/me'))).toMatchObject({ isOrganizer: true, headJudgeDays: [] });
    expect((await anonymous.get('/api/me')).status).toBe(401);
  });

  it('answers 404 for an unknown day or job, whoever asks', async () => {
    expect((await organizer.get('/api/days/99999')).status).toBe(404);
    expect((await headJudge.get('/api/days/99999')).status).toBe(404);
    expect((await organizer.get('/api/days/abc')).status).toBe(404);
    expect((await organizer.get('/api/jobs/99999')).status).toBe(404);
    const noStaff = await patch(organizer, '/api/staff/99999', { displayName: 'X' });
    expect(noStaff.status).toBe(404);
    expect(noStaff.json()).toMatchObject({ data: { code: 'not_found' } });
  });

  it('validates every body: empty, missing fields, wrong types, too long, unknown fields', async () => {
    const bad: [string, string, unknown][] = [
      ['POST', '/api/staff', {}],
      ['POST', '/api/staff', { displayName: 'x'.repeat(65) }],
      ['POST', '/api/staff', { displayName: 'X', playerId: '12ab' }],
      ['POST', '/api/staff', { displayName: 'X', discordUserId: 'not-a-snowflake' }],
      ['POST', '/api/staff', { displayName: 'X', admin: true }],
      ['PATCH', '/api/staff/1', { displayName: '' }],
      ['PATCH', '/api/staff/1', { displayName: '   ' }],
      ['PATCH', '/api/staff/1', { displayName: 'x'.repeat(65) }],
      ['PATCH', '/api/staff/1', { displayName: 5 }],
      ['PATCH', '/api/staff/1', { displayName: null }],
      ['PATCH', '/api/staff/1', { playerId: '12ab' }],
      ['PATCH', '/api/staff/1', { playerId: '' }],
      ['PATCH', '/api/staff/1', { playerId: '12345678901' }],
      ['PATCH', '/api/staff/1', { playerId: 1234567 }],
      ['POST', '/api/days', { title: 'T' }],
      ['POST', '/api/days', { date: '2026-02-30', title: 'T' }],
      ['POST', '/api/days', { date: '2026-10-17', title: 5 }],
      ['POST', `/api/days/${otherDayId}/events`, { name: 'X', game: 'chess', startTime: '10:00' }],
      ['POST', `/api/days/${otherDayId}/events`, { name: 'X', game: 'go', startTime: '24:00' }],
      ['POST', `/api/days/${otherDayId}/events`, { name: 'X', game: 'go', startTime: '10:00', slug: '-bad' }],
      ['POST', `/api/days/${otherDayId}/events`, { name: 'X', game: 'go', startTime: '10:00', tournamentId: '25-12-1050' }],
      ['PUT', `/api/days/${otherDayId}/staff`, { staff: [{ staffMemberId: 'one', events: [] }] }],
      ['PUT', `/api/days/${otherDayId}/staff`, { staff: [{ staffMemberId: 1, events: [{ eventId: 1, role: 'streamer' }] }] }],
      ['POST', '/api/blueprints', { name: 'B', categoryNamePattern: '{title}', channels: [{ key: 'k' }] }],
      ['POST', '/api/templates', { name: 'T', blueprintId: 1, events: [{ name: 'E', game: 'go', startTime: '9:00' }] }],
    ];
    for (const [method, path, json] of bad) {
      const res = await organizer.send(path, { method, json });
      expect(res.status, `${method} ${path} ${JSON.stringify(json)}`).toBe(400);
      expect(res.json(), path).toMatchObject({ data: { code: 'invalid_body', issues: expect.any(Array) } });
    }
  });

  it('stores an XSS display name verbatim and returns it as JSON, on create and on edit', async () => {
    const created = ok(await organizer.post('/api/staff', { displayName: XSS }), 201) as { id: number; displayName: string };
    expect(created.displayName).toBe(XSS);
    const listed = ok(await organizer.get('/api/staff')) as { staff: { displayName: string }[] };
    expect(listed.staff.map((s) => s.displayName)).toContain(XSS);
    const renamed = ok(await organizer.post('/api/staff', { displayName: 'Plain' }), 201) as { id: number };
    ok(await patch(organizer, `/api/staff/${renamed.id}`, { displayName: `${XSS}!` }));
    const relisted = ok(await organizer.get('/api/staff')) as { staff: { id: number; displayName: string }[] };
    expect(relisted.staff.find((s) => s.id === renamed.id)?.displayName).toBe(`${XSS}!`);
  });

  it('lists organizers’ alarms in the status', async () => {
    expect(ok(await organizer.get('/api/status'))).toMatchObject({ alarms: [] });
  });

  it('leaks no secret in any reply', () => {
    for (const b of [owner, organizer, headJudge, otherHeadJudge, anonymous]) expectNoSecrets(replyTexts(b));
    expectNoSecrets([genie.log()]);
  });
});

describe('deleting', () => {
  it('deletes a draft day, refuses an opened one', async () => {
    const draft = ok(await organizer.post('/api/days', { date: '2026-11-01', title: 'Gone' }), 201) as { day: { id: number } };
    expect((await del(organizer, `/api/days/${draft.day.id}`)).status).toBe(204);
    expect((await del(organizer, `/api/days/${dayId}`)).json()).toMatchObject({ data: { code: 'day_not_draft' } });
  });
});
