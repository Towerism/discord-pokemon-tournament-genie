/**
 * The refresh diff (ADR-0008, §4.2): what pulling a day from attendance would change in the day's plan. Pure, so its
 * one hard rule is property-tested: nothing an unread organizer owns is ever removed, and a refresh only ever
 * proposes removing staff an import put there.
 */
import type { EventRole } from '../../../shared/blueprints';
import type { AttendanceDay, AttendanceRole, AttendanceTournament, UnreadReason } from '../attendance/port';

export type Game = 'tcg' | 'vgc' | 'go' | 'other';
export type LinkState = 'unlinked' | 'claimed' | 'linked';

export interface StateEvent {
  id: number;
  name: string;
  startsAt: number;
  game: Game;
  gameConfirmed: boolean;
  tournamentId: string | null;
  /** `null` for an event typed by hand or retired: the diff never touches it. */
  attendanceTournamentId: string | null;
  organizerPlayerId: string | null;
  organizerName: string | null;
}

export interface StateStaff {
  staffMemberId: number;
  displayName: string;
  playerId: string | null;
  /** An import put them on the day. */
  dayImported: boolean;
  /** Genie's roles, so `streaming` too: only an organizer sets it, attendance never does (ADR-0015). */
  roles: { eventId: number; role: EventRole; imported: boolean }[];
}

/** The day as the diff needs it, plus the directory rows for the response's player IDs. */
export interface ImportState {
  dayState: 'draft' | 'open';
  events: StateEvent[];
  staff: StateStaff[];
  directory: { staffMemberId: number; playerId: string; displayName: string; linkState: LinkState }[];
}

export interface NewEvent {
  name: string;
  startsAt: number;
  game: Game;
  gameConfirmed: boolean;
  tournamentId: string | null;
  attendanceTournamentId: string;
  organizer: { playerId: string; name: string };
}

export interface StaffRef {
  playerId: string;
  name: string;
  role: AttendanceRole;
  staffMemberId: number | null;
  linkState: LinkState | null;
}

type Change<T> = { from: T; to: T };

export type DiffItem =
  | { kind: 'event_added'; key: string; event: NewEvent; staff: StaffRef[] }
  | {
      kind: 'event_removed';
      key: string;
      eventId: number;
      name: string;
      effect: 'delete' | 'retire';
      rolesEnded: { imported: number; byHand: number };
      byHandStaff: string[];
      uncertain: boolean;
    }
  | {
      kind: 'event_changed';
      key: string;
      eventId: number;
      name: string;
      changes: { name?: Change<string>; startsAt?: Change<number>; tournamentId?: Change<string | null>; game?: Change<Game> };
    }
  | { kind: 'staff_added'; key: string; eventId: number; staff: StaffRef }
  | { kind: 'staff_removed'; key: string; eventId: number; staffMemberId: number; displayName: string; role: EventRole }
  | { kind: 'role_changed'; key: string; eventId: number; staffMemberId: number; displayName: string; from: EventRole; to: AttendanceRole; setByHand: boolean };

export type NotRefreshedStatus = UnreadReason | 'not_connected';

export interface ImportDiff {
  items: DiffItem[];
  notRefreshed: { eventId: number; name: string; organizer: { playerId: string; name: string | null }; status: NotRefreshedStatus }[];
  unreadProfessors: { playerId: string; name: string; reason: UnreadReason }[];
  skipped: { tournamentId: string; playerId: string; reason: 'invalid_player_id' | 'duplicate_staff' }[];
  organizers: { eventId: number; playerId: string; name: string }[];
}

const PLAYER_ID = /^\d{1,10}$/;
const TOURNAMENT_ID = /^\d{2}-\d{2}-\d{6}$/;
const MAX_NAME = 64;
const KIND_ORDER: DiffItem['kind'][] = ['event_added', 'event_removed', 'event_changed', 'staff_added', 'staff_removed', 'role_changed'];

/** The event an import creates from a tournament (the plan's own limits applied). */
export function buildEvent(t: AttendanceTournament): NewEvent {
  const name = t.name.trim().slice(0, MAX_NAME).trim() || `Tournament ${t.displayId ?? t.id}`.slice(0, MAX_NAME);
  return {
    name,
    startsAt: t.startsAt,
    game: t.game ?? 'other',
    gameConfirmed: t.game !== null,
    tournamentId: t.displayId !== null && TOURNAMENT_ID.test(t.displayId) ? t.displayId : null,
    attendanceTournamentId: t.id,
    organizer: { playerId: t.organizer.playerId, name: t.organizer.name },
  };
}

export function refreshDiff(state: ImportState, day: AttendanceDay): ImportDiff {
  const skipped: ImportDiff['skipped'] = [];
  const directory = new Map(state.directory.map((d) => [d.playerId, d]));
  const staffById = new Map(state.staff.map((s) => [s.staffMemberId, s]));
  const professors = new Map(day.professors.map((p) => [p.playerId, p]));
  const tournaments = new Map(day.tournaments.map((t) => [t.id, t]));
  const linked = state.events.filter((e) => e.attendanceTournamentId !== null);
  const matched = new Set(linked.map((e) => e.attendanceTournamentId));

  /** The tournament's staff with valid, distinct player IDs, matched to the directory. */
  const staffOf = (t: AttendanceTournament): StaffRef[] => {
    const seen = new Set<string>();
    const refs: StaffRef[] = [];
    for (const s of t.staff) {
      if (!PLAYER_ID.test(s.playerId)) {
        skipped.push({ tournamentId: t.id, playerId: s.playerId, reason: 'invalid_player_id' });
        continue;
      }
      if (seen.has(s.playerId)) {
        skipped.push({ tournamentId: t.id, playerId: s.playerId, reason: 'duplicate_staff' });
        continue;
      }
      seen.add(s.playerId);
      const row = directory.get(s.playerId);
      refs.push({ playerId: s.playerId, name: s.name, role: s.role, staffMemberId: row?.staffMemberId ?? null, linkState: row?.linkState ?? null });
    }
    return refs;
  };

  const rolesOn = (eventId: number) =>
    state.staff.flatMap((s) => s.roles.filter((r) => r.eventId === eventId).map((r) => ({ staff: s, role: r.role, imported: r.imported })));

  const statusOf = (e: StateEvent): 'read' | NotRefreshedStatus => {
    const p = professors.get(e.organizerPlayerId!);
    if (!p) return 'not_connected';
    return p.status === 'read' ? 'read' : p.reason;
  };
  const uncertain =
    day.professors.some((p) => p.status === 'unread') || linked.some((e) => !tournaments.has(e.attendanceTournamentId!) && statusOf(e) === 'not_connected');

  const sortable: { item: DiffItem; startsAt: number; name: string }[] = [];
  const notRefreshed: ImportDiff['notRefreshed'] = [];
  const organizers: ImportDiff['organizers'] = [];

  for (const t of sortedTournaments(day.tournaments)) {
    if (matched.has(t.id)) continue;
    const event = buildEvent(t);
    sortable.push({ item: { kind: 'event_added', key: `event+:${t.id}`, event, staff: staffOf(t) }, startsAt: event.startsAt, name: event.name });
  }

  for (const e of sortedEvents(linked)) {
    const at = { startsAt: e.startsAt, name: e.name };
    const t = tournaments.get(e.attendanceTournamentId!);
    if (!t) {
      const status = statusOf(e);
      if (status !== 'read') {
        const p = professors.get(e.organizerPlayerId!);
        notRefreshed.push({ eventId: e.id, name: e.name, organizer: { playerId: e.organizerPlayerId!, name: p?.name ?? e.organizerName }, status });
        continue;
      }
      const roles = rolesOn(e.id);
      const byHand = roles.filter((r) => !r.imported);
      sortable.push({
        item: {
          kind: 'event_removed',
          key: `event-:${e.id}`,
          eventId: e.id,
          name: e.name,
          effect: state.dayState === 'open' ? 'retire' : 'delete',
          rolesEnded: { imported: roles.length - byHand.length, byHand: byHand.length },
          byHandStaff: byHand.map((r) => r.staff.displayName).sort((a, b) => a.localeCompare(b)),
          uncertain,
        },
        ...at,
      });
      continue;
    }

    // Refreshed: its tournament came back, so its organizer (as the response says) was read.
    organizers.push({ eventId: e.id, playerId: t.organizer.playerId, name: t.organizer.name });
    const changes = fieldChanges(e, buildEvent(t), t);
    if (changes) sortable.push({ item: { kind: 'event_changed', key: `event~:${e.id}`, eventId: e.id, name: e.name, changes }, ...at });

    const listed = staffOf(t);
    const current = rolesOn(e.id);
    for (const ref of listed) {
      const held = ref.staffMemberId === null ? undefined : current.find((r) => r.staff.staffMemberId === ref.staffMemberId);
      if (!held) {
        sortable.push({ item: { kind: 'staff_added', key: `staff+:${e.id}:${ref.playerId}`, eventId: e.id, staff: ref }, ...at });
      } else if (held.role !== ref.role) {
        const s = staffById.get(held.staff.staffMemberId)!;
        sortable.push({
          item: {
            kind: 'role_changed',
            key: `role~:${e.id}:${s.staffMemberId}`,
            eventId: e.id,
            staffMemberId: s.staffMemberId,
            displayName: s.displayName,
            from: held.role,
            to: ref.role,
            setByHand: !held.imported,
          },
          ...at,
        });
      }
    }
    const listedPlayers = new Set(listed.map((r) => r.playerId));
    for (const r of current) {
      if (!r.imported || (r.staff.playerId !== null && listedPlayers.has(r.staff.playerId))) continue;
      sortable.push({
        item: { kind: 'staff_removed', key: `staff-:${e.id}:${r.staff.staffMemberId}`, eventId: e.id, staffMemberId: r.staff.staffMemberId, displayName: r.staff.displayName, role: r.role },
        ...at,
      });
    }
  }

  sortable.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind) ||
      a.startsAt - b.startsAt ||
      a.name.localeCompare(b.name) ||
      compareText(a.item.key, b.item.key),
  );

  return {
    items: sortable.map((s) => s.item),
    notRefreshed,
    unreadProfessors: day.professors
      .flatMap((p) => (p.status === 'unread' ? [{ playerId: p.playerId, name: p.name, reason: p.reason }] : []))
      .sort((a, b) => compareText(a.playerId, b.playerId)),
    skipped: skipped.sort((a, b) => compareText(a.tournamentId, b.tournamentId) || compareText(a.playerId, b.playerId) || compareText(a.reason, b.reason)),
    organizers: organizers.sort((a, b) => a.eventId - b.eventId),
  };
}

/** What the tournament would change on a matched event. Unknown values (`game: null`, no valid display ID) never propose a change. */
function fieldChanges(e: StateEvent, built: NewEvent, t: AttendanceTournament) {
  const changes: Extract<DiffItem, { kind: 'event_changed' }>['changes'] = {};
  if (built.name !== e.name) changes.name = { from: e.name, to: built.name };
  if (built.startsAt !== e.startsAt) changes.startsAt = { from: e.startsAt, to: built.startsAt };
  if (built.tournamentId !== null && built.tournamentId !== e.tournamentId) changes.tournamentId = { from: e.tournamentId, to: built.tournamentId };
  if (t.game !== null && built.game !== e.game) changes.game = { from: e.game, to: built.game };
  return Object.keys(changes).length ? changes : null;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedEvents = (events: StateEvent[]) => [...events].sort((a, b) => a.startsAt - b.startsAt || a.name.localeCompare(b.name) || a.id - b.id);
const sortedTournaments = (ts: AttendanceTournament[]) => [...ts].sort((a, b) => a.startsAt - b.startsAt || compareText(a.id, b.id));
