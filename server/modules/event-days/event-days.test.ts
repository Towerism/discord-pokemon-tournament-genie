import { createRedactor, silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BLUEPRINT } from '../../../shared/blueprints';
import { freshDb } from '../../../test/support/db';
import type { OpenDatabase } from '../../db/client';
import { type DirectoryService, createDirectoryService } from '../directory';
import { ServiceError } from '../errors';
import { type Jobs, createJobs } from '../jobs/jobs';
import { createSqliteJobStore } from '../jobs/sqlite-store';
import { type EventDaysService, createEventDaysService } from './index';

const GUILD = '400000000000000001';
const TZ = 'America/Chicago';
const U = (n: number) => `10000000000000000${n}`;

let database: OpenDatabase;
let clock: FakeClock;
let jobs: Jobs;
let directory: DirectoryService;
let days: EventDaysService;

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(1_000);
  jobs = createJobs({ store: createSqliteJobStore(database.db), clock, logger: silentLogger, redactor: createRedactor({ extraKeys: [] }) });
  jobs.register('provision', async () => {});
  jobs.register('sync', async () => {});
  let eventDays: EventDaysService | null = null;
  directory = createDirectoryService({
    db: database.db,
    clock,
    logger: silentLogger,
    onLinkChanged: (id) => eventDays!.onLinkChanged(id),
    isReferenced: (id) => eventDays!.isReferenced(id),
  });
  days = eventDays = createEventDaysService({
    db: database.db,
    clock,
    logger: silentLogger,
    timeZone: TZ,
    guildId: () => GUILD,
    directory,
    enqueueSync: (dayId) => jobs.enqueueUnlessQueued({ kind: 'sync', dayId }).jobId,
    currentSeason: () => '2026-27',
  });
});
afterEach(() => database.close());

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return `${err.status} ${err.code}`;
    throw err;
  }
  return 'no refusal';
};
const queued = () => database.sqlite.prepare("SELECT kind, day_id AS dayId FROM job WHERE state = 'queued' ORDER BY id").all();
const dayRow = (id: number) =>
  database.sqlite.prepare('SELECT state, plan_revision AS planRevision, applied_revision AS appliedRevision, revoke_pending_revision AS revokePending, revoke_pending_at AS revokePendingAt FROM event_day WHERE id = ?').get(id) as {
    state: string;
    planRevision: number;
    appliedRevision: number | null;
    revokePending: number | null;
    revokePendingAt: number | null;
  };
/** Simulates the provisioning job having opened and applied the day. */
const openAndApply = (dayId: number) => {
  days.openDay(dayId, () => 0);
  days.recordApplied(dayId, dayRow(dayId).planRevision);
  database.sqlite.prepare('DELETE FROM job').run();
};

describe('blueprints', () => {
  it('lists the seeded default with its channels', () => {
    const [standard] = days.listBlueprints();
    expect(standard).toMatchObject({ name: 'Standard day', isDefault: true, inUse: false });
    expect(standard!.channels.map((c) => c.key)).toEqual(['day-staff', 'head-judges', 'floor', 'penalties']);
  });

  it('validates a new blueprint and keeps names unique', () => {
    const bad = { ...DEFAULT_BLUEPRINT, name: 'Bad', channels: [{ ...DEFAULT_BLUEPRINT.channels[2]!, audience: 'all_staff' as const }] };
    try {
      days.createBlueprint(bad);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ status: 422, code: 'invalid_blueprint', data: { problems: [{ path: 'channels.0.audience', code: 'audience_not_allowed' }] } });
    }
    expect(refusal(() => days.createBlueprint({ ...DEFAULT_BLUEPRINT }))).toBe('409 name_taken');
    expect(days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Copy' }).isDefault).toBe(false);
  });

  it('freezes a blueprint once a day using it is open, and never deletes the default or one in use', () => {
    const b = days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Saturday' });
    const draft = days.createDay({ date: '2026-10-17', title: 'Draft', blueprintId: b.id });
    const edited = days.putBlueprint(b.id, { ...DEFAULT_BLUEPRINT, name: 'Saturday', categoryNamePattern: '{title}' });
    expect(edited.categoryNamePattern).toBe('{title}');
    expect(refusal(() => days.deleteBlueprint(b.id))).toBe('409 blueprint_in_use');
    days.openDay(draft.day.id, () => 0);
    expect(refusal(() => days.putBlueprint(b.id, { ...DEFAULT_BLUEPRINT, name: 'Saturday' }))).toBe('409 blueprint_in_use');
    expect(refusal(() => days.deleteBlueprint(1))).toBe('409 blueprint_in_use');
    const unused = days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Unused' });
    days.deleteBlueprint(unused.id);
    expect(days.listBlueprints().map((x) => x.name)).toEqual(['Saturday', 'Standard day']);
  });
});

describe('templates and new days', () => {
  it('creates a draft day from a template with its events at local times', () => {
    const b = days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Saturday' });
    const t = days.createTemplate({ name: 'Saturday', blueprintId: b.id, events: [{ name: 'TCG LC', game: 'tcg', startTime: '10:00' }, { name: 'VGC', game: 'vgc', startTime: '11:30' }] });
    const plan = days.createDay({ date: '2026-10-17', title: 'October', templateId: t.id });
    expect(plan.day).toMatchObject({ state: 'draft', blueprintId: b.id, date: '2026-10-17' });
    expect(plan.events.map((e) => [e.slug, e.game, e.startTime, new Date(e.startsAt).toISOString()])).toEqual([
      ['tcg-lc', 'tcg', '10:00', '2026-10-17T15:00:00.000Z'],
      ['vgc', 'vgc', '11:30', '2026-10-17T16:30:00.000Z'],
    ]);
  });

  it('keeps local times across the DST change', () => {
    const t = days.createTemplate({ name: 'Sunday', blueprintId: 1, events: [{ name: 'LC', game: 'tcg', startTime: '10:00' }] });
    expect(new Date(days.createDay({ date: '2026-11-01', title: 'Fall back', templateId: t.id }).events[0]!.startsAt).toISOString()).toBe('2026-11-01T16:00:00.000Z');
  });

  it('uses the default blueprint without one, and refuses unknown ones', () => {
    expect(days.createDay({ date: '2026-10-17', title: 'T' }).day.blueprintId).toBe(1);
    expect(refusal(() => days.createDay({ date: '2026-10-17', title: 'T', blueprintId: 99 }))).toBe('422 unknown_blueprint');
    expect(refusal(() => days.createDay({ date: '2026-10-17', title: 'T', templateId: 99 }))).toBe('422 unknown_template');
    expect(refusal(() => days.createTemplate({ name: 'X', blueprintId: 99, events: [] }))).toBe('422 unknown_blueprint');
  });

  it('keeps template names unique, and edits and deletes templates', () => {
    const t = days.createTemplate({ name: 'Saturday', blueprintId: 1, events: [] });
    expect(refusal(() => days.createTemplate({ name: 'Saturday', blueprintId: 1, events: [] }))).toBe('409 name_taken');
    expect(days.putTemplate(t.id, { name: 'Sat', blueprintId: 1, events: [{ name: 'GO', game: 'go', startTime: '09:00' }] }).events).toHaveLength(1);
    expect(refusal(() => days.deleteBlueprint(1))).toBe('409 blueprint_in_use');
    days.deleteTemplate(t.id);
    expect(days.listTemplates()).toEqual([]);
  });
});

describe('events', () => {
  it('derives unique slugs, refuses a duplicate given slug, and keeps local times when the date moves', () => {
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    const lc2 = days.addEvent(day.id, { name: 'LC!', game: 'tcg', startTime: '12:00', tournamentId: '25-12-001050' });
    expect([lc.slug, lc2.slug, lc2.tournamentId]).toEqual(['lc', 'lc-2', '25-12-001050']);
    expect(refusal(() => days.patchEvent(day.id, lc2.id, { slug: 'lc' }))).toBe('409 slug_taken');
    days.patchDay(day.id, { date: '2026-10-18' });
    expect(days.plan(day.id).events.map((e) => [e.startTime, new Date(e.startsAt).toISOString()])).toEqual([
      ['10:00', '2026-10-18T15:00:00.000Z'],
      ['12:00', '2026-10-18T17:00:00.000Z'],
    ]);
    expect(refusal(() => days.patchEvent(day.id, 999, { name: 'x' }))).toBe('404 not_found');
  });

  it('only deletes events and days while draft, and changes the blueprint only while draft', () => {
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    days.openDay(day.id, () => 0);
    expect(refusal(() => days.deleteEvent(day.id, lc.id))).toBe('409 day_not_draft');
    expect(refusal(() => days.deleteDay(day.id))).toBe('409 day_not_draft');
    const copy = days.createBlueprint({ ...DEFAULT_BLUEPRINT, name: 'Copy' });
    expect(refusal(() => days.patchDay(day.id, { blueprintId: copy.id }))).toBe('409 day_not_draft');
    const other = days.createDay({ date: '2026-10-17', title: 'Other' }).day;
    days.deleteDay(other.id);
    expect(refusal(() => days.plan(other.id))).toBe('404 not_found');
  });
});

describe('edges', () => {
  it('answers not found for unknown blueprints, templates, events and days', () => {
    expect(refusal(() => days.blueprint(99))).toBe('404 not_found');
    expect(refusal(() => days.putBlueprint(99, DEFAULT_BLUEPRINT))).toBe('404 not_found');
    expect(refusal(() => days.deleteBlueprint(99))).toBe('404 not_found');
    expect(refusal(() => days.putTemplate(99, { name: 'x', blueprintId: 1, events: [] }))).toBe('404 not_found');
    expect(refusal(() => days.deleteTemplate(99))).toBe('404 not_found');
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    expect(refusal(() => days.deleteEvent(day.id, 99))).toBe('404 not_found');
    expect(refusal(() => days.addEvent(99, { name: 'x', game: 'go', startTime: '10:00' }))).toBe('404 not_found');
  });

  it('refuses a day before setup binds a guild', () => {
    const unbound = createEventDaysService({ db: database.db, clock, logger: silentLogger, timeZone: TZ, guildId: () => null, directory, enqueueSync: () => 0, currentSeason: () => '2026-27' });
    expect(refusal(() => unbound.createDay({ date: '2026-10-17', title: 'T' }))).toBe('409 setup_incomplete');
  });

  it('edits each field of an event, bumping the revision only for a change', () => {
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00', slug: 'lc' });
    expect(refusal(() => days.addEvent(day.id, { name: 'Other', game: 'tcg', startTime: '10:00', slug: 'lc' }))).toBe('409 slug_taken');
    const revision = dayRow(day.id).planRevision;
    expect(days.patchEvent(day.id, lc.id, {})).toEqual(lc);
    expect(days.patchEvent(day.id, lc.id, { slug: 'lc' }).slug).toBe('lc');
    const edited = days.patchEvent(day.id, lc.id, { name: ' League ', game: 'vgc', startTime: '13:15', tournamentId: '25-12-001050' });
    expect(edited).toMatchObject({ name: 'League', game: 'vgc', startTime: '13:15', tournamentId: '25-12-001050' });
    expect(dayRow(day.id).planRevision).toBe(revision + 2);
    days.patchDay(day.id, {});
    days.patchDay(day.id, { title: ' Renamed ' });
    expect(days.plan(day.id).day.title).toBe('Renamed');
    expect(dayRow(day.id).planRevision).toBe(revision + 3);
    days.deleteEvent(day.id, lc.id);
    expect(days.plan(day.id).events).toEqual([]);
  });

  it('confirms an imported event’s game when the organizer sets it, even to the same game', () => {
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'other', startTime: '10:00' });
    database.sqlite.prepare('UPDATE event SET game_confirmed = 0 WHERE id = ?').run(lc.id);
    const revision = dayRow(day.id).planRevision;

    expect(days.patchEvent(day.id, lc.id, { game: 'other' })).toMatchObject({ game: 'other', gameConfirmed: true });
    expect(dayRow(day.id).planRevision).toBe(revision + 1);
  });

  it('shows where a day and its events came from', () => {
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    expect(days.plan(day.id).day.attendance).toEqual({ source: 'manual', refreshedAt: null });
    expect(days.plan(day.id).events[0]!.attendance).toBeNull();

    database.sqlite
      .prepare("UPDATE event SET attendance_tournament_id = 'g1', attendance_organizer_player_id = '2223334', attendance_organizer_name = 'Prof. Oak' WHERE id = ?")
      .run(lc.id);
    database.sqlite.prepare("UPDATE event_day SET source = 'attendance', attendance_refreshed_at = 5 WHERE id = ?").run(day.id);
    expect(days.plan(day.id).day.attendance).toEqual({ source: 'attendance', refreshedAt: 5 });
    expect(days.plan(day.id).events[0]!.attendance).toEqual({ tournamentId: 'g1', organizerPlayerId: '2223334', organizerName: 'Prof. Oak' });
  });

  it('bumps a draft day but queues nothing when its staffer is relinked', () => {
    const a = directory.create({ displayName: 'A', discordUserId: U(1) });
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }]);
    expect(directory.update(a.id, { discordUserId: U(2) }).syncJobIds).toEqual([]);
    expect(queued()).toEqual([]);
    expect(days.dayHeadJudge(U(9), true)).toBe(false);
  });

  it('reports an unchanged role as no change in the diff', () => {
    const a = directory.create({ displayName: 'A', discordUserId: U(1) });
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    const entry = [{ staffMemberId: a.id, events: [{ eventId: lc.id, role: 'judge' as const }] }];
    days.putStaff(day.id, entry);
    expect(days.putStaff(day.id, entry).diff).toEqual({ added: [], removed: [], eventRolesAdded: [], eventRolesRemoved: [], eventRolesChanged: [] });
    expect(days.putStaff(day.id, []).diff).toMatchObject({ removed: [a.id], eventRolesRemoved: [{ staffMemberId: a.id, eventId: lc.id, role: 'judge' }] });
  });

  it('lists days newest first, and the staff of a day by name', () => {
    const z = directory.create({ displayName: 'Zed', discordUserId: U(1) });
    const a = directory.create({ displayName: 'Amy', discordUserId: U(2) });
    const older = days.createDay({ date: '2026-10-10', title: 'Older' }).day;
    const newer = days.createDay({ date: '2026-10-17', title: 'Newer' }).day;
    days.putStaff(newer.id, [{ staffMemberId: z.id, events: [] }, { staffMemberId: a.id, events: [] }]);
    expect(days.listDays().map((d) => [d.title, d.staffCount])).toEqual([
      ['Newer', 2],
      ['Older', 0],
    ]);
    expect(days.plan(newer.id).staff.map((s) => s.displayName)).toEqual(['Amy', 'Zed']);
    void older;
  });
});

describe('staff and revisions', () => {
  function staffedDay() {
    const a = directory.create({ displayName: 'A', discordUserId: U(1) });
    const b = directory.create({ displayName: 'B', discordUserId: U(2) });
    const c = directory.create({ displayName: 'C', discordUserId: U(3) });
    const { day } = days.createDay({ date: '2026-10-17', title: 'T' });
    const lc = days.addEvent(day.id, { name: 'LC', game: 'tcg', startTime: '10:00' });
    const vgc = days.addEvent(day.id, { name: 'VGC', game: 'vgc', startTime: '11:00' });
    days.putStaff(day.id, [
      { staffMemberId: a.id, events: [{ eventId: lc.id, role: 'judge' }] },
      { staffMemberId: b.id, events: [] },
    ]);
    return { a, b, c, day, lc, vgc };
  }

  it('replaces staff and roles, answering the diff and bumping the revision once', () => {
    const { a, b, c, day, lc, vgc } = staffedDay();
    const before = dayRow(day.id).planRevision;
    const { diff } = days.putStaff(day.id, [
      { staffMemberId: a.id, events: [{ eventId: lc.id, role: 'headjudge' }, { eventId: vgc.id, role: 'judge' }] },
      { staffMemberId: c.id, events: [] },
    ]);
    expect(diff).toEqual({
      added: [c.id],
      removed: [b.id],
      eventRolesAdded: [{ staffMemberId: a.id, eventId: vgc.id, role: 'judge' }],
      eventRolesRemoved: [],
      eventRolesChanged: [{ staffMemberId: a.id, eventId: lc.id, role: 'headjudge', from: 'judge' }],
    });
    expect(dayRow(day.id).planRevision).toBe(before + 1);
  });

  it('keeps the imported flags of every unchanged role and day staffer a replace keeps; a role changed by hand is the organizer’s', () => {
    const { a, b, c, day, lc, vgc } = staffedDay();
    database.sqlite.prepare('UPDATE event_staff SET imported = 1').run();
    database.sqlite.prepare('UPDATE day_staff SET imported = 1').run();
    const flags = () => database.sqlite.prepare('SELECT event_id AS e, role, imported FROM event_staff ORDER BY event_id').all();

    days.putStaff(day.id, [
      { staffMemberId: a.id, events: [{ eventId: lc.id, role: 'judge' }, { eventId: vgc.id, role: 'judge' }] },
      { staffMemberId: b.id, events: [] },
      { staffMemberId: c.id, events: [] },
    ]);
    expect(flags()).toEqual([
      { e: lc.id, role: 'judge', imported: 1 },
      { e: vgc.id, role: 'judge', imported: 0 },
    ]);

    days.putStaff(day.id, [
      { staffMemberId: a.id, events: [{ eventId: lc.id, role: 'headjudge' }, { eventId: vgc.id, role: 'judge' }] },
      { staffMemberId: b.id, events: [] },
      { staffMemberId: c.id, events: [] },
    ]);
    expect(flags()).toEqual([
      { e: lc.id, role: 'headjudge', imported: 0 },
      { e: vgc.id, role: 'judge', imported: 0 },
    ]);
    const dayFlags = database.sqlite.prepare('SELECT staff_member_id AS s, imported FROM day_staff ORDER BY staff_member_id').all();
    expect(dayFlags).toEqual([
      { s: a.id, imported: 1 },
      { s: b.id, imported: 1 },
      { s: c.id, imported: 0 },
    ]);
  });

  it('refuses another day’s event or a staffer twice, changing nothing', () => {
    const { a, day } = staffedDay();
    const other = days.createDay({ date: '2026-10-17', title: 'Other' }).day;
    const foreign = days.addEvent(other.id, { name: 'X', game: 'go', startTime: '10:00' });
    const before = days.plan(day.id);
    expect(refusal(() => days.putStaff(day.id, [{ staffMemberId: a.id, events: [{ eventId: foreign.id, role: 'judge' }] }]))).toBe('422 invalid_staff');
    expect(refusal(() => days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }, { staffMemberId: a.id, events: [] }]))).toBe('422 invalid_staff');
    expect(refusal(() => days.putStaff(day.id, [{ staffMemberId: 999, events: [] }]))).toBe('422 invalid_staff');
    expect(days.plan(day.id)).toEqual(before);
  });

  it('queues one sync at once, in the same transaction, when an open day loses access', () => {
    const { a, b, day, lc } = staffedDay();
    openAndApply(day.id);
    clock.advance(5_000);
    const { syncJobId } = days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }, { staffMemberId: b.id, events: [] }]);
    expect(syncJobId).not.toBeNull();
    expect(dayRow(day.id)).toMatchObject({ revokePending: dayRow(day.id).planRevision, revokePendingAt: 6_000 });
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }]);
    expect(queued()).toEqual([{ kind: 'sync', dayId: day.id }]);
    // The oldest unapplied removal's time stays.
    expect(dayRow(day.id).revokePendingAt).toBe(6_000);
    expect(days.plan(day.id).sync).toMatchObject({ inSync: false, revocationPending: true });
    void lc;
  });

  it('queues nothing for an addition, or for a draft day', () => {
    const { a, b, c, day, lc } = staffedDay();
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }]);
    expect(queued()).toEqual([]);
    openAndApply(day.id);
    const { syncJobId } = days.putStaff(day.id, [
      { staffMemberId: a.id, events: [] },
      { staffMemberId: b.id, events: [{ eventId: lc.id, role: 'judge' }] },
      { staffMemberId: c.id, events: [] },
    ]);
    expect(syncJobId).toBeNull();
    expect(queued()).toEqual([]);
    expect(days.plan(day.id).sync).toMatchObject({ inSync: false, revocationPending: false });
  });

  it('treats a narrowing role change as a removal', () => {
    const { a, b, day, lc } = staffedDay();
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [{ eventId: lc.id, role: 'headjudge' }] }, { staffMemberId: b.id, events: [] }]);
    openAndApply(day.id);
    expect(days.putStaff(day.id, [{ staffMemberId: a.id, events: [{ eventId: lc.id, role: 'judge' }] }, { staffMemberId: b.id, events: [] }]).syncJobId).not.toBeNull();
  });

  it('queues a removal sync for each open day when a staffer is relinked, and clears it once applied', () => {
    const { a, day } = staffedDay();
    openAndApply(day.id);
    const { syncJobIds } = directory.update(a.id, { discordUserId: U(8) });
    expect(syncJobIds).toHaveLength(1);
    expect(queued()).toEqual([{ kind: 'sync', dayId: day.id }]);
    days.recordApplied(day.id, dayRow(day.id).planRevision);
    expect(dayRow(day.id)).toMatchObject({ revokePending: null, revokePendingAt: null });
    expect(days.alarms()).toEqual([]);
  });

  it('keeps the alarm while only an older revision is applied, and lists it for boot', () => {
    const { a, day } = staffedDay();
    openAndApply(day.id);
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [] }]);
    const pending = dayRow(day.id).revokePending!;
    days.recordApplied(day.id, pending - 1);
    expect(days.alarms()).toEqual([{ kind: 'access_not_revoked', dayId: day.id, title: 'T', since: 1_000 }]);
    expect(days.daysNeedingRevocation()).toEqual([day.id]);
  });

  it('knows who is a day head judge, and of which days', () => {
    const { a, b, day, lc } = staffedDay();
    days.putStaff(day.id, [{ staffMemberId: a.id, events: [{ eventId: lc.id, role: 'headjudge' }] }, { staffMemberId: b.id, events: [] }]);
    expect(days.dayHeadJudge(U(1), false)).toBe(true);
    expect(days.dayHeadJudge(U(2), false)).toBe(false);
    expect(days.dayHeadJudge(U(2), true)).toBe(true);
    expect(days.dayHeadJudge(U(3), true)).toBe(false);
    expect(days.headJudgeDays(U(1), false).map((d) => d.id)).toEqual([day.id]);
    expect(days.isReferenced(a.id)).toBe(true);
  });
});
