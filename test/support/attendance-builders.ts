import type { ImportState, StateEvent, StateStaff } from '../../server/modules/attendance-import/diff';
import type { AttendanceDay, AttendanceRole, AttendanceTournament, ProfessorStatus } from '../../server/modules/attendance/port';

/** 2026-10-17 at hh:mm in Chicago (CDT, UTC−5). */
export const chicago = (hhmm: string) => Date.parse(`2026-10-17T${hhmm}:00-05:00`);

export const professor = {
  read: (playerId: string, name = `Prof. ${playerId}`): ProfessorStatus => ({ playerId, name, status: 'read' }),
  unread: (playerId: string, reason: 'needs_reconnect' | 'read_failed' = 'needs_reconnect', name = `Prof. ${playerId}`): ProfessorStatus => ({
    playerId,
    name,
    status: 'unread',
    reason,
  }),
};

/** A tournament with sensible defaults; staff as `[playerId, role, name?]`. */
export function tournament(
  id: string,
  over: Partial<Omit<AttendanceTournament, 'staff'>> & { staff?: [string, AttendanceRole, string?][] } = {},
): AttendanceTournament {
  const { staff = [], ...rest } = over;
  return {
    id,
    name: `Cup ${id}`,
    displayId: null,
    startsAt: chicago('10:00'),
    game: 'tcg',
    organizer: { playerId: 'oak', name: 'Prof. Oak' },
    ...rest,
    staff: staff.map(([playerId, role, name]) => ({ playerId, role, name: name ?? `Player ${playerId}` })),
  };
}

export function attendanceDay(over: Partial<AttendanceDay> = {}): AttendanceDay {
  return { date: '2026-10-17', timeZone: 'America/Chicago', tournaments: [], professors: [professor.read('oak')], ...over };
}

/** An event already on the day; `tournament` links it to attendance with its organizer. */
export function stateEvent(id: number, over: Partial<StateEvent> = {}): StateEvent {
  return {
    id,
    name: `Event ${id}`,
    startsAt: chicago('10:00'),
    game: 'tcg',
    gameConfirmed: true,
    tournamentId: null,
    attendanceTournamentId: null,
    organizerPlayerId: null,
    organizerName: null,
    ...over,
  };
}

export const linkedTo = (tournamentId: string, organizerPlayerId = 'oak') => ({
  attendanceTournamentId: tournamentId,
  organizerPlayerId,
  organizerName: `Prof. ${organizerPlayerId}`,
});

/** A day staffer; roles as `[eventId, role, imported]`. */
export function stateStaff(
  staffMemberId: number,
  playerId: string | null,
  roles: [number, AttendanceRole, boolean][] = [],
  over: Partial<StateStaff> = {},
): StateStaff {
  return {
    staffMemberId,
    displayName: `Staff ${staffMemberId}`,
    playerId,
    dayImported: false,
    roles: roles.map(([eventId, role, imported]) => ({ eventId, role, imported })),
    ...over,
  };
}

export function importState(over: Partial<ImportState> = {}): ImportState {
  const state: ImportState = { dayState: 'draft', events: [], staff: [], directory: [], ...over };
  // Every day staffer with a player ID is in the directory, linked unless the test says otherwise.
  for (const s of state.staff) {
    if (s.playerId && !state.directory.some((d) => d.playerId === s.playerId)) {
      state.directory.push({ staffMemberId: s.staffMemberId, playerId: s.playerId, displayName: s.displayName, linkState: 'linked' });
    }
  }
  return state;
}
