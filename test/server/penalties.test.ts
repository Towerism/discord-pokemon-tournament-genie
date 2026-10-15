import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FakeDiscord } from '../../server/modules/discord/fake';
import { PERMISSION_BITS as P } from '../../shared/discord/permissions';
import { IDS, storeWorld } from '../support/discord-world';
import { type FakeDiscordHttp, startFakeDiscordHttp } from '../support/fake-discord-http';
import { completeSetup, loginThroughDiscord } from '../support/flows';
import { type Genie, startGenie } from '../support/genie-process';
import { type Browser, type Reply, browser } from '../support/http-client';

const ASH = '100000000000000201'; // LC head judge
const BROCK = '100000000000000202'; // LC judge
const MISTY = '100000000000000203'; // VGC judge
const GARY = '100000000000000204'; // VGC head judge
const ROLE_HJ = '100000000000000205'; // holds the head-judge role, on the day's staff, heads no event
const OTHER = '100000000000000206'; // head judge of another day
const XSS = '<img src=x onerror=alert(1)>';
const SQLI = "'); DROP TABLE penalty; --";
const NOTE = 'Shuffled-the-deck-poorly-note-4471';
const COMPETITOR = '9876501';
const REASON = 'void-reason-sentinel-8823';

let fake: FakeDiscord;
let discord: FakeDiscordHttp;
let genie: Genie;
let organizer: Browser;
let ash: Browser;
let gary: Browser;
let roleHeadJudge: Browser;
let otherDayHeadJudge: Browser;
let anonymous: Browser;
let dayId: number;
let lcId: number;
let vgcId: number;
let brockId: number;
let ashId: number;
let garyId: number;
let catalog: { categories: { id: number; label: string }[]; types: { id: number; label: string }[] };

const ok = (r: Reply, status = 200) => {
  expect(r.status, r.text).toBe(status);
  return r.json<Record<string, unknown>>();
};
const patch = (b: Browser, path: string, json: unknown) => b.send(path, { method: 'PATCH', json });
const code = (r: Reply) => (r.json<{ data?: { code?: string } }>().data?.code ?? null);

async function signedIn(userId: string): Promise<Browser> {
  const b = browser(genie.url);
  expect((await loginThroughDiscord(b, discord, userId)).location).toBe('/');
  return b;
}

async function finished(jobId: number) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { job } = ok(await organizer.get(`/api/jobs/${jobId}`)) as { job: { state: string } };
    if (job.state !== 'queued' && job.state !== 'running') return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${job.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const id = (label: string, list: { id: number; label: string }[]) => list.find((r) => r.label === label)!.id;
const createBody = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: randomUUID(),
  eventId: lcId,
  round: 3,
  competitorPlayerId: COMPETITOR,
  categoryId: id('Game Play', catalog.categories),
  severity: 'Minor',
  penaltyTypeId: id('Warning', catalog.types),
  notes: NOTE,
  judgeStaffMemberId: brockId,
  ...over,
});
const cardsIn = (name: string) => {
  const channel = [...fake.channels.values()].find((c) => c.name === name)!;
  return [...fake.messages.values()].filter((m) => m.channelId === channel.id);
};

beforeAll(async () => {
  fake = storeWorld();
  fake.guilds.get(IDS.guild)!.ownerId = IDS.owner;
  for (const [userId, name] of [
    [ASH, 'Ash'],
    [BROCK, 'Brock'],
    [MISTY, 'Misty'],
    [GARY, 'Gary'],
    [OTHER, 'Other'],
  ] as const) {
    fake.addMember(IDS.guild, userId, [], { displayName: name, username: name.toLowerCase() });
  }
  fake.addMember(IDS.guild, ROLE_HJ, [IDS.headJudgeRole], { displayName: 'Role HJ', username: 'rolehj' });
  fake.guilds.get(IDS.guild)!.roles[0]!.permissions = P.ViewChannel | P.SendMessages | P.ReadMessageHistory;
  discord = await startFakeDiscordHttp(fake);
  genie = await startGenie({ discordUrl: discord.url, env: { NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '1000' } });
  const owner = browser(genie.url);
  anonymous = browser(genie.url);
  await completeSetup(owner, genie, discord);
  organizer = await signedIn(IDS.organizer);

  const staff = async (displayName: string, discordUserId: string, playerId: string) =>
    (ok(await organizer.post('/api/staff', { displayName, discordUserId, playerId }), 201) as { id: number }).id;
  ashId = await staff('Ash', ASH, '00111');
  brockId = await staff('Brock', BROCK, '00222');
  const mistyId = await staff('Misty', MISTY, '00333');
  garyId = await staff('Gary', GARY, '00444');
  const roleId = await staff('Role HJ', ROLE_HJ, '00555');
  const otherId = await staff('Other', OTHER, '00666');

  dayId = (ok(await organizer.post('/api/days', { date: '2026-10-17', title: 'October LC' }), 201) as { day: { id: number } }).day.id;
  lcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'LC', game: 'tcg', startTime: '10:00', tournamentId: '26-10-000123' }), 201) as { id: number }).id;
  vgcId = (ok(await organizer.post(`/api/days/${dayId}/events`, { name: 'VGC', game: 'vgc', startTime: '11:30' }), 201) as { id: number }).id;
  ok(
    await organizer.put(`/api/days/${dayId}/staff`, {
      staff: [
        { staffMemberId: ashId, events: [{ eventId: lcId, role: 'headjudge' }] },
        { staffMemberId: brockId, events: [{ eventId: lcId, role: 'judge' }] },
        { staffMemberId: mistyId, events: [{ eventId: vgcId, role: 'judge' }] },
        { staffMemberId: garyId, events: [{ eventId: vgcId, role: 'headjudge' }] },
        { staffMemberId: roleId, events: [] },
      ],
    }),
  );
  const other = (ok(await organizer.post('/api/days', { date: '2026-10-18', title: 'Other' }), 201) as { day: { id: number } }).day.id;
  const otherEvent = (ok(await organizer.post(`/api/days/${other}/events`, { name: 'GO', game: 'go', startTime: '09:00' }), 201) as { id: number }).id;
  ok(await organizer.put(`/api/days/${other}/staff`, { staff: [{ staffMemberId: otherId, events: [{ eventId: otherEvent, role: 'headjudge' }] }] }));

  const { jobId } = ok(await organizer.post(`/api/days/${dayId}/open`), 202) as { jobId: number };
  expect(await finished(jobId)).toMatchObject({ state: 'succeeded' });
  catalog = ok(await organizer.get('/api/catalog')) as typeof catalog;

  ash = await signedIn(ASH);
  gary = await signedIn(GARY);
  roleHeadJudge = await signedIn(ROLE_HJ);
  otherDayHeadJudge = await signedIn(OTHER);
});
afterAll(async () => {
  await genie.stop();
  await discord.close();
});

describe('recording and changing penalties on the website', () => {
  it('lists only the head judge’s event, with its judges and options', async () => {
    const view = ok(await ash.get(`/api/days/${dayId}/penalties`)) as { events: { id: number; judges: { name: string }[]; options: { types: { label: string }[] } }[] };
    expect(view.events.map((e) => e.id)).toEqual([lcId]);
    expect(view.events[0]!.judges.map((j) => j.name)).toEqual(['Ash', 'Brock']);
    expect(view.events[0]!.options.types.map((t) => t.label)).toEqual(['Warning', 'DPC', 'QPC', 'GL', 'DQ']);
    const all = ok(await organizer.get(`/api/days/${dayId}/penalties`)) as { events: { id: number }[] };
    expect(all.events.map((e) => e.id)).toEqual([lcId, vgcId]);
  });

  it('records once per form, posts the card, and answers the same row on a retry', async () => {
    const body = createBody();
    const first = ok(await ash.post(`/api/days/${dayId}/penalties`, body), 201) as { penalty: { id: number; number: number; cardState: string; judge: { playerId: string } }; created: boolean };
    expect(first).toMatchObject({ created: true, penalty: { number: 1, cardState: 'posted', judge: { playerId: '00222' } } });
    expect(first.penalty).not.toHaveProperty('judgeDiscordUserId');
    expect(cardsIn('lc-penalties')).toHaveLength(1);
    const again = ok(await ash.post(`/api/days/${dayId}/penalties`, body)) as { penalty: { id: number }; created: boolean };
    expect(again).toMatchObject({ created: false, penalty: { id: first.penalty.id } });
    expect(cardsIn('lc-penalties')).toHaveLength(1);
  });

  it('refuses a stale revision, and voids with a reason', async () => {
    const { penalty } = ok(await ash.post(`/api/days/${dayId}/penalties`, createBody({ round: 5 })), 201) as { penalty: { id: number } };
    const edited = ok(await patch(ash, `/api/days/${dayId}/penalties/${penalty.id}`, { revision: 1, severity: 'Major' })) as { penalty: { revision: number } };
    expect(edited.penalty.revision).toBe(2);
    const stale = await patch(ash, `/api/days/${dayId}/penalties/${penalty.id}`, { revision: 1, severity: 'Severe' });
    expect([stale.status, code(stale)]).toEqual([409, 'revision_conflict']);
    const voided = ok(await ash.post(`/api/days/${dayId}/penalties/${penalty.id}/void`, { revision: 2, reason: REASON })) as { penalty: { state: string } };
    expect(voided.penalty.state).toBe('voided');
  });

  it('reposts a card someone deleted', async () => {
    const { penalty } = ok(await ash.post(`/api/days/${dayId}/penalties`, createBody()), 201) as { penalty: { id: number } };
    const before = cardsIn('lc-penalties').map((m) => m.id);
    const mine = before.at(-1)!;
    fake.messages.delete(mine);
    const reposted = ok(await ash.post(`/api/days/${dayId}/penalties/${penalty.id}/repost`, {})) as { penalty: { cardState: string } };
    expect(reposted.penalty.cardState).toBe('posted');
    expect(cardsIn('lc-penalties').map((m) => m.id)).not.toContain(mine);
    expect(cardsIn('lc-penalties')).toHaveLength(before.length);
  });

  it('stores and returns hostile text verbatim in JSON', async () => {
    const { penalty } = ok(await ash.post(`/api/days/${dayId}/penalties`, createBody({ notes: `${XSS} ${SQLI}` })), 201) as { penalty: { id: number; notes: string } };
    expect(penalty.notes).toBe(`${XSS} ${SQLI}`);
    const listed = ok(await ash.get(`/api/days/${dayId}/penalties`)) as { penalties: { id: number; notes: string }[] };
    expect(listed.penalties.find((p) => p.id === penalty.id)?.notes).toBe(`${XSS} ${SQLI}`);
  });
});

describe('who may use the penalty routes', () => {
  let vgcPenalty: number;
  beforeAll(async () => {
    vgcPenalty = (ok(await gary.post(`/api/days/${dayId}/penalties`, createBody({ eventId: vgcId, judgeStaffMemberId: garyId })), 201) as { penalty: { id: number } }).penalty.id;
  });

  it('answers each caller as the matrix says, on every route', async () => {
    const { penalty } = ok(await ash.post(`/api/days/${dayId}/penalties`, createBody()), 201) as { penalty: { id: number } };
    const routes: [string, (b: Browser) => Promise<Reply>][] = [
      ['list', (b) => b.get(`/api/days/${dayId}/penalties`)],
      ['create', (b) => b.post(`/api/days/${dayId}/penalties`, createBody())],
      ['edit', (b) => patch(b, `/api/days/${dayId}/penalties/${penalty.id}`, { revision: 99 })],
      ['void', (b) => b.post(`/api/days/${dayId}/penalties/${penalty.id}/void`, { revision: 99, reason: 'x' })],
      ['repost', (b) => b.post(`/api/days/${dayId}/penalties/${penalty.id}/repost`, {})],
      ['csv', (b) => b.get(`/api/days/${dayId}/penalties.csv?eventId=${lcId}`)],
    ];
    for (const [name, call] of routes) {
      expect((await call(anonymous)).status, `${name} anonymous`).toBe(401);
      for (const [who, b] of [
        ['role-only day head judge', roleHeadJudge],
        ['head judge of another day', otherDayHeadJudge],
        ...(name === 'list' ? [] : ([['head judge of another event', gary]] as const)),
      ] as const) {
        const reply = await call(b);
        expect([reply.status, code(reply)], `${name} ${who}`).toEqual([403, 'forbidden']);
        expect(reply.text, `${name} ${who}`).not.toContain(COMPETITOR);
      }
      expect([200, 201, 409].includes((await call(ash)).status), `${name} head judge`).toBe(true);
      expect([200, 201, 409].includes((await call(organizer)).status), `${name} organizer`).toBe(true);
    }
  });

  it('lists for the head judge of another event only that event', async () => {
    const view = ok(await gary.get(`/api/days/${dayId}/penalties`)) as { events: { id: number }[]; penalties: { eventId: number }[] };
    expect(view.events.map((e) => e.id)).toEqual([vgcId]);
    expect(view.penalties.every((p) => p.eventId === vgcId)).toBe(true);
  });

  it('gives another event’s penalty and a missing one the same answer', async () => {
    for (const path of [`/api/days/${dayId}/penalties/${vgcPenalty}`, `/api/days/${dayId}/penalties/999999`]) {
      const reply = await patch(ash, path, { revision: 1, severity: 'Major' });
      expect([reply.status, reply.json()]).toEqual([403, expect.objectContaining({ data: { code: 'forbidden' } })]);
    }
    expect((await patch(organizer, `/api/days/${dayId}/penalties/999999`, { revision: 1 })).status).toBe(404);
  });

  it('keeps the catalog and the season for organizers', async () => {
    for (const [method, path, json] of [
      ['GET', '/api/catalog', undefined],
      ['PUT', '/api/catalog/2026-27', { categories: [], types: [] }],
      ['PUT', '/api/settings/season', { season: '2026-27' }],
    ] as const) {
      expect((await anonymous.send(path, { method, json })).status).toBe(401);
      expect((await ash.send(path, { method, json })).status).toBe(403);
    }
  });

  it('shows the day’s season and whether the caller can open its penalties', async () => {
    expect(ok(await ash.get(`/api/days/${dayId}`))).toMatchObject({ day: { season: '2026-27' }, can: { penalties: true } });
    expect(ok(await roleHeadJudge.get(`/api/days/${dayId}`))).toMatchObject({ can: { penalties: false } });
    expect(ok(await organizer.get(`/api/days/${dayId}`))).toMatchObject({ can: { penalties: true } });
  });
});

describe('the input matrix', () => {
  it('refuses every malformed body with invalid_body, and accepts the boundaries', async () => {
    const post = (body: unknown) => ash.post(`/api/days/${dayId}/penalties`, body);
    const bad: unknown[] = [
      {},
      null,
      'text',
      createBody({ unknown: 1 }),
      createBody({ round: 0 }),
      createBody({ round: 100 }),
      createBody({ round: '3' }),
      createBody({ round: 2.5 }),
      createBody({ competitorPlayerId: '12345678901' }),
      createBody({ competitorPlayerId: 12345 }),
      createBody({ notes: 'x'.repeat(1001) }),
      createBody({ severity: 'minor' }),
      createBody({ idempotencyKey: 'not-a-uuid' }),
      createBody({ eventId: null }),
    ];
    for (const key of Object.keys(createBody())) {
      bad.push(Object.fromEntries(Object.entries(createBody()).filter(([k]) => k !== key)));
    }
    for (const body of bad) {
      const reply = await post(body);
      expect([reply.status, code(reply)], JSON.stringify(body)?.slice(0, 80)).toEqual([400, 'invalid_body']);
    }
    for (const over of [{ round: 1 }, { round: 99 }, { competitorPlayerId: '1234567890' }, { notes: 'x'.repeat(1000) }, { notes: '' }]) {
      expect((await post(createBody(over))).status, JSON.stringify(over).slice(0, 60)).toBe(201);
    }
    const vgcByAsh = await post(createBody({ eventId: vgcId }));
    expect([vgcByAsh.status, code(vgcByAsh)]).toEqual([403, 'forbidden']);
    const dpcOnVgc = await gary.post(`/api/days/${dayId}/penalties`, createBody({ eventId: vgcId, judgeStaffMemberId: garyId, penaltyTypeId: id('DPC', catalog.types) }));
    expect([dpcOnVgc.status, code(dpcOnVgc)]).toEqual([422, 'invalid_catalog_choice']);
  });

  it('checks catalog labels at 100 and 101 characters', async () => {
    const current = ok(await organizer.get('/api/catalog')) as typeof catalog & { categories: object[]; types: { id: number; label: string; games: string[]; rank: number; active: boolean }[] };
    const withLabel = (label: string) => ({ categories: current.categories, types: current.types.map((t, i) => (i === 4 ? { ...t, label } : t)) });
    expect((await organizer.put('/api/catalog/2026-27', withLabel('x'.repeat(101)))).status).toBe(400);
    expect((await organizer.put('/api/catalog/2026-27', withLabel('x'.repeat(100)))).status).toBe(200);
    ok(await organizer.put('/api/catalog/2026-27', withLabel('DQ')));
  });
});

describe('the CSV', () => {
  it('downloads the event’s active and voided penalties, never cached, and refuses an event without a Tournament ID', async () => {
    const csv = await ash.get(`/api/days/${dayId}/penalties.csv?eventId=${lcId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csv.headers['content-disposition']).toBe('attachment; filename="26-10-000123-penalties.csv"');
    expect(csv.headers['cache-control']).toBe('no-store');
    const lines = csv.text.split('\n');
    expect(lines[0]).toBe("Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes");
    expect(lines.slice(1).every((l) => l === '' || l.startsWith('26-10-000123,'))).toBe(true);
    expect(csv.text.endsWith('\n')).toBe(true);
    const voided = await ash.get(`/api/days/${dayId}/penalties.csv?eventId=${lcId}&voided=1`);
    expect(voided.headers['content-disposition']).toBe('attachment; filename="26-10-000123-penalties-voided.csv"');
    expect(voided.text.split('\n').filter((l) => l.startsWith('26-10-000123,5,'))).toHaveLength(1);

    const blocked = await organizer.get(`/api/days/${dayId}/penalties.csv?eventId=${vgcId}`);
    expect([blocked.status, blocked.json()]).toEqual([422, expect.objectContaining({ data: { code: 'export_blocked', problems: [{ code: 'tournament_id_missing' }] } })]);
    expect((await ash.get(`/api/days/${dayId}/penalties.csv`)).status).toBe(400);
  });
});

describe('the catalog’s refusals over HTTP', () => {
  type Row = { id?: number; label: string; games: string[]; rank: number; active: boolean };
  const put = (season: string, types: Row[], categories: Row[]) => organizer.put(`/api/catalog/${season}`, { categories, types });

  it('answers each refusal with its code, and swaps two labels in one save', async () => {
    const current = ok(await organizer.get('/api/catalog?season=2026-27')) as { categories: Row[]; types: Row[] };
    const { categories, types } = current;
    const expectCode = async (reply: Promise<Reply>, status: number, expected: string) => {
      const r = await reply;
      expect([r.status, code(r)]).toEqual([status, expected]);
    };
    await expectCode(put('2026-27', types.slice(1), categories), 422, 'row_missing');
    await expectCode(put('2026-27', [...types, { label: types[0]!.label.toLowerCase(), games: ['tcg'], rank: 9, active: true }], categories), 422, 'duplicate_label');
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `T${i}`, games: ['tcg'], rank: 50 + i, active: true }));
    await expectCode(put('2026-27', [...types, ...many], categories), 422, 'too_many_options');
    await expectCode(put('2026-27', types.map((t) => ({ ...t, active: false })), categories), 422, 'no_options');
    await expectCode(put('2026-27', [...types, { ...types[0]!, label: 'Twice' }], categories), 422, 'duplicate_row');
    await expectCode(put('1999-00', [], []), 404, 'not_found');
    expect((await organizer.put('/api/catalog/%E0%A4%A', { categories, types })).status).toBe(404);

    const swap = (label: string) => (label === 'Warning' ? 'DQ' : label === 'DQ' ? 'Warning' : label);
    const swapped = ok(await put('2026-27', types.map((t) => ({ ...t, label: swap(t.label) })), categories)) as { types: Row[] };
    expect(swapped.types.map((t) => t.label)).toEqual(types.map((t) => swap(t.label)));
    ok(await put('2026-27', types, categories));
  });
});

describe('the season and the catalog over HTTP', () => {
  it('starts a new season as a copy, keeps the open day on its own, and reports it in Settings', async () => {
    const empty = await organizer.put('/api/settings/season', { season: '2027-28' });
    expect([empty.status, code(empty)]).toEqual([422, 'season_empty']);
    ok(await organizer.put('/api/settings/season', { season: '2027-28', copyFrom: '2026-27' }));
    expect(ok(await organizer.get('/api/settings'))).toMatchObject({ currentSeason: '2027-28' });
    expect(ok(await organizer.get('/api/catalog'))).toMatchObject({ season: '2027-28', seasons: expect.arrayContaining(['2026-27', '2027-28']) });
    expect(ok(await organizer.get(`/api/days/${dayId}`))).toMatchObject({ day: { season: '2026-27' } });
    ok(await organizer.put('/api/settings/season', { season: '2026-27' }));
  });
});

describe('a card channel deleted before the next sync', () => {
  const LOST_NOTE = 'lost-channel-note-5150';
  const LOST_COMPETITOR = '7770001';

  it('records the penalty with a failed card, refuses the repost as unavailable, and logs nothing it carried', async () => {
    const channel = [...fake.channels.values()].find((c) => c.name === 'lc-penalties')!;
    fake.channels.delete(channel.id);
    const { penalty } = ok(await ash.post(`/api/days/${dayId}/penalties`, createBody({ notes: LOST_NOTE, competitorPlayerId: LOST_COMPETITOR })), 201) as { penalty: { id: number; cardState: string } };
    expect(penalty.cardState).toBe('failed');
    const repost = await ash.post(`/api/days/${dayId}/penalties/${penalty.id}/repost`, {});
    expect([repost.status, code(repost)]).toEqual([503, 'discord_unavailable']);
    const log = genie.log();
    expect(log).toContain('Could not post a penalty card.');
    expect(log).not.toContain(LOST_NOTE);
    expect(log).not.toContain(LOST_COMPETITOR);
    expect(log).not.toContain('00222');
  });
});

describe('the log', () => {
  it('holds no notes, competitor IDs or void reasons, and records each CSV download', () => {
    const log = genie.log();
    expect(log).toContain('penalty_csv_downloaded');
    expect(log).not.toContain(NOTE);
    expect(log).not.toContain(COMPETITOR);
    expect(log).not.toContain(REASON);
  });
});
