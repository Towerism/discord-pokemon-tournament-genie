import { silentLogger } from '@towerism/selfhost-kit';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attendanceDay, chicago, professor, tournament } from '../../../test/support/attendance-builders';
import { PEOPLE, type ProvisioningWorld, provisioningWorld } from '../../../test/support/provisioning-world';
import type { DirectoryService } from '../directory';
import { ServiceError } from '../errors';
import { type FakeAttendance, createFakeAttendance } from '../attendance/fake';
import type { AttendanceDay, AttendanceRole } from '../attendance/port';
import { type AttendanceImportService, createAttendanceImportService } from '.';

const DATE = '2026-10-17';
const ORGANIZER = '100000000000000999';
const SEED = 20261020;

let w: ProvisioningWorld;
let attendance: FakeAttendance;
let connected: boolean;
let imports: AttendanceImportService;

function build(directory: DirectoryService = w.directory) {
  return createAttendanceImportService({
    db: w.database.db,
    clock: w.clock,
    logger: silentLogger,
    timeZone: 'America/Chicago',
    eventDays: w.days,
    directory,
    source: () => (connected ? attendance : null),
  });
}

beforeEach(() => {
  w = provisioningWorld();
  attendance = createFakeAttendance();
  connected = true;
  imports = build();
});
afterEach(() => w.close());

const serve = (day: Partial<AttendanceDay>) => attendance.days.set(DATE, attendanceDay(day));
const newDay = () => w.days.createDay({ date: DATE, title: 'T' }).day.id;
const keysOf = (diff: { items: { key: string }[] }) => diff.items.map((i) => i.key);
const row = <T>(sql: string, ...args: unknown[]) => w.database.sqlite.prepare(sql).get(...args) as T;
const rows = <T>(sql: string, ...args: unknown[]) => w.database.sqlite.prepare(sql).all(...args) as T[];
const planRevision = (dayId: number) => row<{ r: number }>('SELECT plan_revision AS r FROM event_day WHERE id = ?', dayId).r;
const queuedJobs = () => rows<{ kind: string }>("SELECT kind FROM job WHERE state = 'queued'");

async function refusal(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ServiceError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'no refusal';
}

async function pullAndAcceptAll(dayId: number) {
  const pulled = await imports.pull(dayId, ORGANIZER);
  return { pulled, accepted: imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: keysOf(pulled.diff) }) };
}

describe('a first import', () => {
  it('creates the events, seeds new directory rows, never renames an existing one, and bumps the revision once', async () => {
    const ash = w.directory.create({ displayName: 'Ash (linked)', playerId: '00777', discordUserId: PEOPLE.ash });
    const dayId = newDay();
    serve({
      tournaments: [
        tournament('olives', {
          name: 'Olive Cup',
          game: null,
          displayId: '26-10-000001',
          startsAt: chicago('18:30'),
          organizer: { playerId: '9999991', name: 'Olive Oak' },
          staff: [
            ['00777', 'judge', 'Ash Ketchum'],
            ['00888', 'scorekeeper', 'Misty Waterflower'],
          ],
        }),
      ],
      professors: [professor.read('9999991', 'Olive Oak')],
    });
    w.clock.set(5_000_000);
    const revision = planRevision(dayId);

    const { pulled, accepted } = await pullAndAcceptAll(dayId);

    expect(pulled.fetchedAt).toBe(5_000_000);
    expect(accepted.applied).toBe(1);
    expect(accepted.syncJobId).toBeNull();
    const [event] = accepted.plan.events;
    expect(event).toMatchObject({
      name: 'Olive Cup',
      slug: 'olive-cup',
      game: 'other',
      gameConfirmed: false,
      startTime: '18:30',
      tournamentId: '26-10-000001',
      attendance: { tournamentId: 'olives', organizerPlayerId: '9999991', organizerName: 'Olive Oak' },
    });
    expect(accepted.plan.day.attendance).toEqual({ source: 'attendance', refreshedAt: 5_000_000 });
    const misty = w.directory.list().find((s) => s.playerId === '00888')!;
    expect(misty).toMatchObject({ displayName: 'Misty Waterflower', linkState: 'unlinked', discordUserId: null });
    expect(w.directory.get(ash.id)).toMatchObject({ displayName: 'Ash (linked)', linkState: 'linked' });
    expect(accepted.plan.staff.map((s) => [s.displayName, s.events.map((e) => e.role)])).toEqual([
      ['Ash (linked)', ['judge']],
      ['Misty Waterflower', ['scorekeeper']],
    ]);
    expect(rows('SELECT imported FROM day_staff')).toEqual([{ imported: 1 }, { imported: 1 }]);
    expect(rows('SELECT imported FROM event_staff')).toEqual([{ imported: 1 }, { imported: 1 }]);
    expect(planRevision(dayId)).toBe(revision + 1);
    expect(queuedJobs()).toEqual([]);
    expect(rows('SELECT * FROM attendance_snapshot')).toEqual([]);
  });

  it('seeds a nameless staffer as Player <id>', async () => {
    const dayId = newDay();
    serve({ tournaments: [tournament('t', { staff: [['4242', 'judge', '  ']] })] });
    await pullAndAcceptAll(dayId);
    expect(w.directory.list().map((s) => s.displayName)).toEqual(['Player 4242']);
  });

  it('records a refresh that found nothing without bumping the revision', async () => {
    const dayId = newDay();
    serve({ tournaments: [] });
    w.clock.set(7_000_000);
    const revision = planRevision(dayId);
    const { accepted } = await pullAndAcceptAll(dayId);
    expect(accepted.applied).toBe(0);
    expect(accepted.plan.day.attendance).toEqual({ source: 'attendance', refreshedAt: 7_000_000 });
    expect(planRevision(dayId)).toBe(revision);
  });
});

describe('a refresh of an open day', () => {
  /** An open, provisioned day with Oak's imported event: Brock imported as judge, linked. */
  async function openDayWithOakEvent() {
    w.directory.create({ displayName: 'Brock', playerId: '1002', discordUserId: PEOPLE.brock });
    w.directory.create({ displayName: 'Misty', playerId: '1003', discordUserId: PEOPLE.misty });
    const dayId = newDay();
    serve({
      tournaments: [
        tournament('oak-t', { name: 'Oak Cup', organizer: { playerId: 'oak', name: 'Prof. Oak' }, staff: [['1002', 'judge']] }),
        tournament('elm-t', { name: 'Elm Cup', organizer: { playerId: 'elm', name: 'Prof. Elm' }, staff: [['1003', 'judge']] }),
      ],
      professors: [professor.read('oak'), professor.read('elm')],
    });
    await pullAndAcceptAll(dayId);
    await w.provisioning.open(dayId);
    await w.jobs.runDue();
    const oak = w.days.plan(dayId).events.find((e) => e.name === 'Oak Cup')!;
    return { dayId, oak };
  }

  it('retires a removed event: its staff lose access at once, its channels stay, and later refreshes ignore it', async () => {
    const { dayId, oak } = await openDayWithOakEvent();
    expect(w.staffViewers('oak-cup-floor')).toEqual([PEOPLE.brock]);
    serve({
      tournaments: [tournament('elm-t', { name: 'Elm Cup', organizer: { playerId: 'elm', name: 'Prof. Elm' }, staff: [['1003', 'judge']] })],
      professors: [professor.read('oak'), professor.read('elm')],
    });

    const pulled = await imports.pull(dayId, ORGANIZER);
    expect(pulled.diff.items).toEqual([expect.objectContaining({ kind: 'event_removed', key: `event-:${oak.id}`, effect: 'retire', uncertain: false })]);
    const accepted = imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: [`event-:${oak.id}`] });

    expect(accepted.syncJobId).not.toBeNull();
    expect(queuedJobs()).toEqual([{ kind: 'sync' }]);
    expect(row<{ p: number | null }>('SELECT revoke_pending_revision AS p FROM event_day WHERE id = ?', dayId).p).toBe(planRevision(dayId));
    expect(accepted.plan.staff.map((s) => s.displayName)).toEqual(['Misty']);
    expect(accepted.plan.events.find((e) => e.id === oak.id)).toMatchObject({ name: 'Oak Cup', attendance: null });

    await w.jobs.runDue();
    expect(w.staffViewers('oak-cup-floor')).toEqual([]);
    expect(w.staffViewers('oak-cup-penalties')).toEqual([]);
    expect(w.staffViewers('day-staff')).toEqual([PEOPLE.misty]);
    expect(rows("SELECT state FROM provisioned_channel WHERE event_id = ?", oak.id)).toEqual([{ state: 'present' }, { state: 'present' }]);

    const again = await imports.pull(dayId, ORGANIZER);
    expect(again.diff.items).toEqual([]);
    expect(again.diff.notRefreshed).toEqual([]);
  });

  it('refuses an accept made against the draft day once the day has been opened', async () => {
    w.directory.create({ displayName: 'Brock', playerId: '1002', discordUserId: PEOPLE.brock });
    const dayId = newDay();
    serve({ tournaments: [tournament('oak-t', { name: 'Oak Cup', staff: [['1002', 'judge']] })] });
    await pullAndAcceptAll(dayId);
    serve({ tournaments: [] });
    const pulled = await imports.pull(dayId, ORGANIZER);
    expect(pulled.diff.items).toEqual([expect.objectContaining({ kind: 'event_removed', effect: 'delete' })]);

    await w.provisioning.open(dayId);
    await w.jobs.runDue();

    expect(await refusal(() => imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: keysOf(pulled.diff) }))).toBe(
      '409 plan_changed',
    );
    expect(w.days.plan(dayId).events).toHaveLength(1);
  });

  it('applies nothing when the accept fails part way', async () => {
    const dayId = newDay();
    serve({ tournaments: [tournament('t', { staff: [['501', 'judge'], ['502', 'judge']] })] });
    const pulled = await imports.pull(dayId, ORGANIZER);
    let calls = 0;
    const failing: DirectoryService = {
      ...w.directory,
      ensureForImport(playerId, name) {
        calls += 1;
        if (calls === 2) throw new Error('disk full');
        return w.directory.ensureForImport(playerId, name);
      },
    };
    const revision = planRevision(dayId);

    expect(() => build(failing).accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: keysOf(pulled.diff) })).toThrow('disk full');

    expect(w.directory.list()).toEqual([]);
    expect(w.days.plan(dayId).events).toEqual([]);
    expect(planRevision(dayId)).toBe(revision);
    expect(rows('SELECT snapshot_id AS s FROM attendance_snapshot')).toEqual([{ s: pulled.snapshotId }]);
    expect(queuedJobs()).toEqual([]);
  });
});

describe('accepting', () => {
  async function pulledDay() {
    const dayId = newDay();
    serve({ tournaments: [tournament('t', { staff: [['601', 'judge']] })] });
    await pullAndAcceptAll(dayId);
    serve({ tournaments: [tournament('t', { name: 'Renamed upstream', staff: [['601', 'judge'], ['602', 'scorekeeper', 'Newcomer']] })] });
    return { dayId, pulled: await imports.pull(dayId, ORGANIZER) };
  }

  it('applies only the chosen items', async () => {
    const { dayId, pulled } = await pulledDay();
    const eventId = w.days.plan(dayId).events[0]!.id;
    expect(keysOf(pulled.diff)).toEqual([`event~:${eventId}`, `staff+:${eventId}:602`]);

    const accepted = imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: [`staff+:${eventId}:602`] });

    expect(accepted.applied).toBe(1);
    expect(accepted.plan.events[0]!.name).toBe('Cup t');
    expect(accepted.plan.staff.map((s) => s.displayName).sort()).toEqual(['Newcomer', 'Player 601']);
  });

  it('refuses unknown items, a changed plan, an older or expired snapshot, and a closed day', async () => {
    const { dayId, pulled } = await pulledDay();
    const accept = (over: Partial<{ snapshotId: string; planRevision: number; keys: string[] }> = {}) => () =>
      imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: [], ...over });

    const err = await refusal(accept({ keys: ['staff+:999:1'] }));
    expect(err).toBe('422 unknown_items');
    expect(await refusal(accept({ planRevision: pulled.planRevision - 1 }))).toBe('409 plan_changed');
    expect(await refusal(accept({ snapshotId: '00000000-0000-4000-8000-000000000000' }))).toBe('409 snapshot_stale');

    w.clock.advance(61 * 60_000);
    expect(await refusal(accept())).toBe('409 snapshot_stale');

    const fresh = await imports.pull(dayId, ORGANIZER);
    expect(await refusal(accept())).toBe('409 snapshot_stale');
    expect(fresh.snapshotId).not.toBe(pulled.snapshotId);

    w.database.sqlite.prepare("UPDATE event_day SET state = 'closed' WHERE id = ?").run(dayId);
    expect(await refusal(() => imports.accept(dayId, { snapshotId: fresh.snapshotId, planRevision: fresh.planRevision, keys: [] }))).toBe('409 day_not_editable');
    expect(await refusal(() => imports.pull(dayId, ORGANIZER))).toBe('409 day_not_editable');
  });

  it('names the unknown keys', async () => {
    const { dayId, pulled } = await pulledDay();
    try {
      imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: ['nope', 'staff+:1:1'] });
    } catch (err) {
      expect((err as ServiceError).data).toEqual({ keys: ['nope', 'staff+:1:1'] });
      return;
    }
    throw new Error('expected a refusal');
  });

  it('refuses edits made after the pull', async () => {
    const { dayId, pulled } = await pulledDay();
    w.days.patchDay(dayId, { title: 'Edited' });
    expect(await refusal(() => imports.accept(dayId, { snapshotId: pulled.snapshotId, planRevision: pulled.planRevision, keys: [] }))).toBe('409 plan_changed');
  });
});

describe('who leaves the day', () => {
  it('only staffers an import brought, once they hold no role', async () => {
    const dayId = newDay();
    const hand = w.days.addEvent(dayId, { name: 'Hand LC', game: 'tcg', startTime: '09:00' });
    const k = w.directory.create({ displayName: 'K', playerId: '701' });
    w.days.putStaff(dayId, [{ staffMemberId: k.id, events: [] }]);
    serve({ tournaments: [tournament('t', { name: 'Imported', staff: [['701', 'judge'], ['702', 'judge', 'L']] })] });
    await pullAndAcceptAll(dayId);
    const l = w.directory.list().find((s) => s.playerId === '702')!;
    const entries = w.days.plan(dayId).staff.map((s) => ({ staffMemberId: s.staffMemberId, events: s.events }));
    w.days.putStaff(
      dayId,
      entries.map((e) => (e.staffMemberId === l.id ? { ...e, events: [...e.events, { eventId: hand.id, role: 'judge' as const }] } : e)),
    );

    serve({ tournaments: [tournament('t', { name: 'Imported', staff: [] })] });
    await pullAndAcceptAll(dayId);

    expect(w.days.plan(dayId).staff.map((s) => [s.displayName, s.events.length])).toEqual([
      ['K', 0],
      ['L', 1],
    ]);
  });

  it('a staffer whose last imported role goes leaves the day', async () => {
    const dayId = newDay();
    serve({ tournaments: [tournament('t', { staff: [['801', 'judge']] })] });
    await pullAndAcceptAll(dayId);
    serve({ tournaments: [tournament('t', { staff: [] })] });
    await pullAndAcceptAll(dayId);
    expect(w.days.plan(dayId).staff).toEqual([]);
  });
});

describe('pulling', () => {
  it('maps each attendance failure, and leaves the plan and the earlier snapshot alone', async () => {
    const dayId = newDay();
    serve({ tournaments: [tournament('t')] });
    const first = await imports.pull(dayId, ORGANIZER);

    attendance.failNext(
      { kind: 'unavailable' },
      { kind: 'auth' },
      { kind: 'rate_limited', retryAfterSeconds: 30 },
      { kind: 'rejected', upstreamCode: 'league_not_selected' },
      { kind: 'bad_response' },
    );
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      try {
        await imports.pull(dayId, ORGANIZER);
      } catch (err) {
        const e = err as ServiceError;
        outcomes.push([e.status, e.code, e.data]);
      }
    }
    expect(outcomes).toEqual([
      [503, 'attendance_unavailable', {}],
      [502, 'attendance_token_rejected', {}],
      [503, 'attendance_rate_limited', { retryAfterSeconds: 30 }],
      [502, 'attendance_rejected', { upstreamCode: 'league_not_selected' }],
      [502, 'attendance_bad_response', { reason: 'schema' }],
    ]);
    expect(rows('SELECT snapshot_id AS s FROM attendance_snapshot')).toEqual([{ s: first.snapshotId }]);
  });

  it('refuses another time zone, no connected professor, and no connection', async () => {
    const dayId = newDay();
    serve({ timeZone: 'Europe/London' });
    const err = await imports.pull(dayId, ORGANIZER).catch((e: ServiceError) => e);
    expect(err).toMatchObject({ status: 422, code: 'timezone_mismatch', data: { attendanceTimeZone: 'Europe/London', genieTimeZone: 'America/Chicago' } });

    serve({ professors: [] });
    expect(await refusal(() => imports.pull(dayId, ORGANIZER))).toBe('422 no_connected_organizers');

    connected = false;
    expect(await refusal(() => imports.pull(dayId, ORGANIZER))).toBe('409 attendance_not_configured');
    expect(rows('SELECT * FROM attendance_snapshot')).toEqual([]);
  });

  it('accepts a zone alias of Genie’s own zone', async () => {
    const dayId = newDay();
    serve({ timeZone: 'America/Chicago' });
    const aliased = createAttendanceImportService({
      db: w.database.db,
      clock: w.clock,
      logger: silentLogger,
      timeZone: 'US/Central',
      eventDays: w.days,
      directory: w.directory,
      source: () => attendance,
    });
    await expect(aliased.pull(dayId, ORGANIZER)).resolves.toMatchObject({ diff: { items: [] } });
  });

  it('lets one pull of a day wait on attendance at a time, however it ends', async () => {
    const dayId = newDay();
    serve({ tournaments: [] });
    let release!: () => void;
    attendance.gate = new Promise((resolve) => (release = resolve));
    const first = imports.pull(dayId, ORGANIZER);

    expect(await refusal(() => imports.pull(dayId, ORGANIZER))).toBe('409 import_in_progress');
    const otherDay = newDay();
    attendance.gate = null;
    await expect(imports.pull(otherDay, ORGANIZER)).resolves.toBeDefined();

    release();
    await expect(first).resolves.toBeDefined();
    await expect(imports.pull(dayId, ORGANIZER)).resolves.toBeDefined();

    attendance.failNext({ kind: 'unavailable' });
    await imports.pull(dayId, ORGANIZER).catch(() => undefined);
    await expect(imports.pull(dayId, ORGANIZER)).resolves.toBeDefined();
  });

  it('refuses an unknown day', async () => {
    expect(await refusal(() => imports.pull(999, ORGANIZER))).toBe('404 not_found');
  });
});

describe('opening an imported day', () => {
  it('needs an unknown game confirmed first', async () => {
    w.directory.create({ displayName: 'Brock', playerId: '1002', discordUserId: PEOPLE.brock });
    const dayId = newDay();
    serve({ tournaments: [tournament('t', { game: null, staff: [['1002', 'judge']] })] });
    await pullAndAcceptAll(dayId);
    const event = w.days.plan(dayId).events[0]!;

    await expect(w.provisioning.open(dayId)).rejects.toMatchObject({ code: 'open_preconditions_failed', data: { problems: [{ code: 'unconfirmed_game', eventIds: [event.id] }] } });
    w.days.patchEvent(dayId, event.id, { game: 'other' });
    await expect(w.provisioning.open(dayId)).resolves.toMatchObject({ jobId: expect.any(Number) });
  });
});

describe('accepting is idempotent', () => {
  const ROLES: AttendanceRole[] = ['headjudge', 'judge', 'scorekeeper'];
  const response = fc.record({
    tournaments: fc.uniqueArray(
      fc.record({
        id: fc.constantFrom('a', 'b', 'c', 'd'),
        name: fc.constantFrom('Cup', 'League', 'Open'),
        hour: fc.constantFrom('09:00', '10:00', '12:00'),
        game: fc.constantFrom('tcg' as const, 'vgc' as const, null),
        displayId: fc.constantFrom(null, '26-10-000001', '26-10-000002', 'bad'),
        organizer: fc.constantFrom('oak', 'elm'),
        staff: fc.uniqueArray(fc.record({ player: fc.constantFrom('11', '12', '13', '14'), role: fc.constantFrom(...ROLES) }), { selector: (s) => s.player, maxLength: 3 }),
      }),
      { selector: (t) => t.id, maxLength: 4 },
    ),
    elm: fc.constantFrom('read', 'unread', 'missing'),
  });
  const toDay = (r: fc.Infer<typeof response>): AttendanceDay => {
    const professors = [professor.read('oak')];
    if (r.elm === 'read') professors.push(professor.read('elm'));
    if (r.elm === 'unread') professors.push(professor.unread('elm'));
    return attendanceDay({
      professors,
      tournaments: r.tournaments
        .filter((t) => t.organizer === 'oak' || r.elm === 'read')
        .map((t) =>
          tournament(t.id, {
            name: t.name,
            startsAt: chicago(t.hour),
            game: t.game,
            displayId: t.displayId,
            organizer: { playerId: t.organizer, name: t.organizer },
            staff: t.staff.map((s) => [s.player, s.role]),
          }),
        ),
    });
  };

  it('a second pull of the same answer, after accepting everything, proposes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(response, response, async (first, second) => {
        w.close();
        w = provisioningWorld();
        imports = build();
        const dayId = newDay();
        attendance.days.set(DATE, toDay(first));
        await pullAndAcceptAll(dayId);
        attendance.days.set(DATE, toDay(second));
        await pullAndAcceptAll(dayId);

        const again = await imports.pull(dayId, ORGANIZER);
        expect(again.diff.items).toEqual([]);
      }),
      { seed: SEED, numRuns: 60 },
    );
  });
});
