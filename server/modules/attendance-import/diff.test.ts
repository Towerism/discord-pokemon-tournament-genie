import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  attendanceDay,
  chicago,
  importState,
  linkedTo,
  professor,
  stateEvent,
  stateStaff,
  tournament,
} from '../../../test/support/attendance-builders';
import type { AttendanceDay, AttendanceRole } from '../attendance/port';
import { type DiffItem, type ImportState, buildEvent, refreshDiff } from './diff';

const SEED = 20261019;
const kinds = (items: DiffItem[]) => items.map((i) => `${i.kind} ${i.key}`);

describe('refreshDiff: a first import', () => {
  it('proposes each tournament as a new event with its staff, matched to the directory by player ID', () => {
    const state = importState({
      directory: [{ staffMemberId: 7, playerId: '00777', displayName: 'Ash (directory)', linkState: 'linked' }],
    });
    const day = attendanceDay({
      tournaments: [
        tournament('olives', {
          name: 'Olive Cup',
          game: null,
          displayId: '26-10-000001',
          organizer: { playerId: 'oak', name: 'Prof. Oak' },
          staff: [
            ['00777', 'judge', 'Ash Ketchum'],
            ['00888', 'scorekeeper', 'Misty Waterflower'],
          ],
        }),
      ],
    });

    const diff = refreshDiff(state, day);

    expect(diff.items).toEqual([
      {
        kind: 'event_added',
        key: 'event+:olives',
        event: {
          name: 'Olive Cup',
          startsAt: chicago('10:00'),
          game: 'other',
          gameConfirmed: false,
          tournamentId: '26-10-000001',
          attendanceTournamentId: 'olives',
          organizer: { playerId: 'oak', name: 'Prof. Oak' },
        },
        staff: [
          { playerId: '00777', name: 'Ash Ketchum', role: 'judge', staffMemberId: 7, linkState: 'linked' },
          { playerId: '00888', name: 'Misty Waterflower', role: 'scorekeeper', staffMemberId: null, linkState: null },
        ],
      },
    ]);
    expect(diff.notRefreshed).toEqual([]);
    expect(diff.unreadProfessors).toEqual([]);
  });

  it('builds the event the way the plan stores it', () => {
    expect(buildEvent(tournament('t', { displayId: '25-10-1050', game: 'vgc' }))).toMatchObject({ tournamentId: null, game: 'vgc', gameConfirmed: true });
    expect(buildEvent(tournament('t', { name: `  ${'N'.repeat(70)}  ` })).name).toBe('N'.repeat(64));
    expect(buildEvent(tournament('t', { name: '   ', displayId: '26-10-000009' })).name).toBe('Tournament 26-10-000009');
    expect(buildEvent(tournament('guid-1', { name: '' })).name).toBe('Tournament guid-1');
    expect(buildEvent(tournament('t', { game: 'go' })).game).toBe('go');
  });
});

describe('refreshDiff across organizers', () => {
  const state = (dayState: 'draft' | 'open') =>
    importState({
      dayState,
      events: [
        stateEvent(1, { name: 'Oak LC', ...linkedTo('oak-t', 'oak') }),
        stateEvent(2, { name: 'Elm LC', ...linkedTo('elm-t', 'elm') }),
        stateEvent(3, { name: 'Birch LC', ...linkedTo('birch-t', 'birch') }),
        stateEvent(4, { name: 'Typed by hand' }),
      ],
      staff: [
        stateStaff(10, '1010', [[1, 'judge', true]]),
        stateStaff(11, '1011', [[1, 'judge', false]], { displayName: 'Hand Judge' }),
        stateStaff(12, '1012', [[2, 'judge', true]]),
        stateStaff(13, '1013', [[3, 'judge', true]]),
      ],
    });
  const response = attendanceDay({ professors: [professor.read('oak'), professor.unread('elm', 'needs_reconnect', 'Prof. Elm')] });

  it('removes only a read organizer’s absent tournament; unread and disconnected organizers’ events are not refreshed', () => {
    const diff = refreshDiff(state('draft'), response);

    expect(kinds(diff.items)).toEqual(['event_removed event-:1']);
    expect(diff.items[0]).toMatchObject({ effect: 'delete', rolesEnded: { imported: 1, byHand: 1 }, byHandStaff: ['Hand Judge'], uncertain: true });
    // Same start, so by name.
    expect(diff.notRefreshed).toEqual([
      { eventId: 3, name: 'Birch LC', organizer: { playerId: 'birch', name: 'Prof. birch' }, status: 'not_connected' },
      { eventId: 2, name: 'Elm LC', organizer: { playerId: 'elm', name: 'Prof. Elm' }, status: 'needs_reconnect' },
    ]);
    expect(diff.unreadProfessors).toEqual([{ playerId: 'elm', name: 'Prof. Elm', reason: 'needs_reconnect' }]);
  });

  it('retires instead of deleting on an open day', () => {
    expect(refreshDiff(state('open'), response).items[0]).toMatchObject({ effect: 'retire' });
  });

  it('is certain only when every professor was read and no stored organizer is disconnected', () => {
    const onlyOak = importState({ events: [stateEvent(1, linkedTo('oak-t', 'oak'))] });
    expect(refreshDiff(onlyOak, attendanceDay({ professors: [professor.read('oak'), professor.read('elm')] })).items[0]).toMatchObject({
      uncertain: false,
      rolesEnded: { imported: 0, byHand: 0 },
      byHandStaff: [],
    });
    expect(refreshDiff(onlyOak, attendanceDay({ professors: [professor.read('oak'), professor.unread('elm', 'read_failed')] })).items[0]).toMatchObject({
      uncertain: true,
    });
  });
});

describe('refreshDiff: staff of a refreshed event', () => {
  it('removes only imported roles, changes roles, adds newcomers, and skips bad or repeated player IDs', () => {
    const state = importState({
      events: [stateEvent(1, { name: 'LC', ...linkedTo('lc') })],
      staff: [
        stateStaff(1, '111', [[1, 'judge', true]], { displayName: 'J' }),
        stateStaff(2, '222', [[1, 'judge', false]], { displayName: 'H' }),
        stateStaff(3, '333', [[1, 'scorekeeper', true]], { displayName: 'S' }),
        stateStaff(4, null, [[1, 'judge', true]], { displayName: 'No player ID' }),
      ],
    });
    const day = attendanceDay({
      tournaments: [
        tournament('lc', {
          name: 'Event 1',
          staff: [
            ['333', 'judge'],
            ['444', 'judge', 'Newcomer'],
            ['12ab', 'judge'],
            ['444', 'translator'],
          ],
        }),
      ],
    });

    const diff = refreshDiff(state, day);

    expect(diff.items).toEqual([
      { kind: 'event_changed', key: 'event~:1', eventId: 1, name: 'LC', changes: { name: { from: 'LC', to: 'Event 1' } } },
      { kind: 'staff_added', key: 'staff+:1:444', eventId: 1, staff: { playerId: '444', name: 'Newcomer', role: 'judge', staffMemberId: null, linkState: null } },
      { kind: 'staff_removed', key: 'staff-:1:1', eventId: 1, staffMemberId: 1, displayName: 'J', role: 'judge' },
      { kind: 'staff_removed', key: 'staff-:1:4', eventId: 1, staffMemberId: 4, displayName: 'No player ID', role: 'judge' },
      { kind: 'role_changed', key: 'role~:1:3', eventId: 1, staffMemberId: 3, displayName: 'S', from: 'scorekeeper', to: 'judge', setByHand: false },
    ]);
    expect(diff.skipped).toEqual([
      { tournamentId: 'lc', playerId: '12ab', reason: 'invalid_player_id' },
      { tournamentId: 'lc', playerId: '444', reason: 'duplicate_staff' },
    ]);
  });

  it('flags a role the organizer set by hand', () => {
    const state = importState({ events: [stateEvent(1, linkedTo('lc'))], staff: [stateStaff(2, '222', [[1, 'headjudge', false]])] });
    const day = attendanceDay({ tournaments: [tournament('lc', { name: 'Event 1', staff: [['222', 'judge']] })] });
    expect(refreshDiff(state, day).items).toEqual([expect.objectContaining({ kind: 'role_changed', setByHand: true, from: 'headjudge', to: 'judge' })]);
  });

  it('adds a directory member who isn’t on the event yet, with their row', () => {
    const state = importState({
      events: [stateEvent(1, linkedTo('lc'))],
      directory: [{ staffMemberId: 9, playerId: '999', displayName: 'Brock', linkState: 'claimed' }],
    });
    const day = attendanceDay({ tournaments: [tournament('lc', { name: 'Event 1', staff: [['999', 'judge', 'Brock H.']] })] });
    expect(refreshDiff(state, day).items).toEqual([
      { kind: 'staff_added', key: 'staff+:1:999', eventId: 1, staff: { playerId: '999', name: 'Brock H.', role: 'judge', staffMemberId: 9, linkState: 'claimed' } },
    ]);
  });
});

describe('refreshDiff: event fields', () => {
  const base = () =>
    importState({ events: [stateEvent(1, { name: 'Renamed by hand', startsAt: chicago('11:00'), game: 'vgc', tournamentId: '26-10-000001', ...linkedTo('lc') })] });

  it('proposes name and time changes, but never a game attendance doesn’t know or a display ID it can’t give', () => {
    const day = attendanceDay({ tournaments: [tournament('lc', { name: 'October LC', startsAt: chicago('10:00'), game: null, displayId: null })] });
    const malformed = attendanceDay({ tournaments: [tournament('lc', { name: 'October LC', startsAt: chicago('10:00'), game: null, displayId: '25-10-1050' })] });
    expect(refreshDiff(base(), malformed)).toEqual(refreshDiff(base(), day));
    expect(refreshDiff(base(), day).items).toEqual([
      {
        kind: 'event_changed',
        key: 'event~:1',
        eventId: 1,
        name: 'Renamed by hand',
        changes: { name: { from: 'Renamed by hand', to: 'October LC' }, startsAt: { from: chicago('11:00'), to: chicago('10:00') } },
      },
    ]);
  });

  it('proposes a known game and a new display ID', () => {
    const day = attendanceDay({
      tournaments: [tournament('lc', { name: 'Renamed by hand', startsAt: chicago('11:00'), game: 'tcg', displayId: '26-10-000002' })],
    });
    expect(refreshDiff(base(), day).items).toEqual([
      expect.objectContaining({ changes: { game: { from: 'vgc', to: 'tcg' }, tournamentId: { from: '26-10-000001', to: '26-10-000002' } } }),
    ]);
  });

  it('records a tournament that moved to another professor as metadata, not as an item', () => {
    const day = attendanceDay({
      professors: [professor.read('oak'), professor.read('elm')],
      tournaments: [tournament('lc', { name: 'Renamed by hand', startsAt: chicago('11:00'), game: 'vgc', displayId: '26-10-000001', organizer: { playerId: 'elm', name: 'Prof. Elm' } })],
    });
    const diff = refreshDiff(base(), day);
    expect(diff.items).toEqual([]);
    expect(diff.organizers).toEqual([{ eventId: 1, playerId: 'elm', name: 'Prof. Elm' }]);
  });

  it('never touches an event typed by hand', () => {
    const state = importState({ events: [stateEvent(1)], staff: [stateStaff(1, '111', [[1, 'judge', true]])] });
    const diff = refreshDiff(state, attendanceDay({ professors: [professor.read('oak')] }));
    expect(diff.items).toEqual([]);
    expect(diff.notRefreshed).toEqual([]);
  });
});

describe('refreshDiff ordering', () => {
  it('sorts by kind, then start, then name, then key', () => {
    const day = attendanceDay({
      tournaments: [
        tournament('b', { name: 'Same', startsAt: chicago('09:00') }),
        tournament('a', { name: 'Same', startsAt: chicago('09:00') }),
        tournament('c', { name: 'Early', startsAt: chicago('08:00') }),
        tournament('d', { name: 'Alpha', startsAt: chicago('09:00') }),
      ],
    });
    expect(kinds(refreshDiff(importState(), day).items)).toEqual(['event_added event+:c', 'event_added event+:d', 'event_added event+:a', 'event_added event+:b']);
  });
});

// ---- property: unread organizers never cost data

const ORGANIZERS = ['oak', 'elm', 'birch', 'rowan'];
const ROLES: AttendanceRole[] = ['headjudge', 'judge', 'scorekeeper', 'administration', 'translator'];
const PLAYERS = ['100', '101', '102', '103', '104', '105'];

const scenario = fc
  .record({
    dayState: fc.constantFrom('draft' as const, 'open' as const),
    events: fc.array(
      fc.record({
        linked: fc.boolean(),
        organizer: fc.constantFrom(...ORGANIZERS),
        inResponse: fc.boolean(),
        hour: fc.integer({ min: 8, max: 20 }),
        roles: fc.array(fc.record({ player: fc.constantFrom(...PLAYERS), role: fc.constantFrom(...ROLES), imported: fc.boolean() }), { maxLength: 4 }),
        responseStaff: fc.array(fc.record({ player: fc.constantFrom(...PLAYERS, 'bad!'), role: fc.constantFrom(...ROLES) }), { maxLength: 4 }),
      }),
      { maxLength: 6 },
    ),
    extraTournaments: fc.integer({ min: 0, max: 2 }),
    professors: fc.array(fc.record({ organizer: fc.constantFrom(...ORGANIZERS), status: fc.constantFrom('read', 'unread', 'missing') }), { maxLength: 4 }),
  })
  .map(({ dayState, events, extraTournaments, professors }) => {
    const statuses = new Map(professors.map((p) => [p.organizer, p.status]));
    const state: ImportState = { dayState, events: [], staff: [], directory: [] };
    const response: AttendanceDay = { date: '2026-10-17', timeZone: 'America/Chicago', tournaments: [], professors: [] };
    for (const [organizer, status] of statuses) {
      if (status === 'read') response.professors.push(professor.read(organizer));
      if (status === 'unread') response.professors.push(professor.unread(organizer));
    }
    const staffById = new Map<number, ImportState['staff'][number]>();
    events.forEach((e, i) => {
      const id = i + 1;
      const tid = `t${id}`;
      state.events.push(stateEvent(id, { startsAt: chicago(`${String(e.hour).padStart(2, '0')}:00`), ...(e.linked ? linkedTo(tid, e.organizer) : {}) }));
      for (const r of e.roles) {
        const staffMemberId = PLAYERS.indexOf(r.player) + 1;
        const s = staffById.get(staffMemberId) ?? stateStaff(staffMemberId, r.player);
        if (!s.roles.some((x) => x.eventId === id)) s.roles.push({ eventId: id, role: r.role, imported: r.imported });
        staffById.set(staffMemberId, s);
      }
      // Only a read professor's tournaments can be in the response.
      if (e.linked && e.inResponse && statuses.get(e.organizer) === 'read') {
        response.tournaments.push(tournament(tid, { organizer: { playerId: e.organizer, name: e.organizer }, staff: e.responseStaff.map((s) => [s.player, s.role]) }));
      }
    });
    for (let i = 0; i < extraTournaments; i++) response.tournaments.push(tournament(`new${i}`));
    state.staff = [...staffById.values()];
    return { state: importState(state), response, statuses };
  });

describe('refreshDiff properties', () => {
  it('never removes or changes an unread organizer’s event or staff, never removes a hand-added role, and is deterministic', () => {
    fc.assert(
      fc.property(scenario, ({ state, response, statuses }) => {
        const diff = refreshDiff(state, response);
        const inResponse = new Set(response.tournaments.map((t) => t.id));
        const event = (id: number) => state.events.find((e) => e.id === id)!;
        const roleOf = (eventId: number, staffMemberId: number) =>
          state.staff.find((s) => s.staffMemberId === staffMemberId)!.roles.find((r) => r.eventId === eventId)!;

        for (const item of diff.items) {
          if (item.kind === 'event_added') continue;
          const e = event(item.eventId);
          // No item ever names an event typed by hand (or retired).
          expect(e.attendanceTournamentId).not.toBeNull();
          if (item.kind === 'event_removed') {
            expect(inResponse.has(e.attendanceTournamentId!)).toBe(false);
            expect(statuses.get(e.organizerPlayerId!)).toBe('read');
          } else {
            // Staff and field changes only for a refreshed event: its tournament is in the response.
            expect(inResponse.has(e.attendanceTournamentId!)).toBe(true);
          }
          if (item.kind === 'staff_removed') expect(roleOf(item.eventId, item.staffMemberId).imported).toBe(true);
        }
        // Deterministic, and blind to input order.
        const shuffled: ImportState = { ...state, events: [...state.events].reverse(), staff: [...state.staff].reverse() };
        expect(refreshDiff(shuffled, { ...response, tournaments: [...response.tournaments].reverse() })).toEqual(diff);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('computes a large day quickly (logged, not asserted)', () => {
    const tournaments = Array.from({ length: 50 }, (_, i) =>
      tournament(`t${i}`, { organizer: { playerId: `p${i % 10}`, name: 'P' }, staff: Array.from({ length: 20 }, (_, j) => [String(i * 100 + j), 'judge'] as [string, AttendanceRole]) }),
    );
    const day = attendanceDay({ tournaments, professors: Array.from({ length: 10 }, (_, i) => professor.read(`p${i}`)) });
    const started = performance.now();
    refreshDiff(importState(), day);
    console.info(`refreshDiff of 10 professors × 5 tournaments × 20 staff: ${(performance.now() - started).toFixed(1)} ms`);
  });
});
