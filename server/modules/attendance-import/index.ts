/**
 * Import and refresh from attendance (ADR-0008, §4.2). A pull reads the day through the `AttendanceSource` port,
 * stores the answer as the day's snapshot and answers the diff. Accepting applies the chosen items in one transaction,
 * through the `event-days` and `directory` services, only while the plan and the day's state are as the pull saw them.
 */
import { randomUUID } from 'node:crypto';
import type { Clock, Logger } from '@towerism/selfhost-kit';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { attendanceSnapshot } from '../../db/schema';
import type { DirectoryService } from '../directory';
import type { DayPlanCore, EventDaysService, ImportOps } from '../event-days';
import { ServiceError } from '../errors';
import {
  type AttendanceDay,
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  type AttendanceSource,
  AttendanceUnavailableError,
  canonicalTimeZone,
} from '../attendance/port';
import { type DiffItem, type ImportDiff, type ImportState, refreshDiff } from './diff';

export type { DiffItem, ImportDiff } from './diff';

/** How long a pull may wait for its accept (§4.2: a snapshot, not a live link). */
export const SNAPSHOT_TTL_MS = 60 * 60_000;

export interface Pulled {
  snapshotId: string;
  planRevision: number;
  /** The day's state the diff was made against: what its removals mean (delete or retire, revoking at once). */
  dayState: 'draft' | 'open';
  fetchedAt: number;
  diff: ImportDiff;
}

export function createAttendanceImportService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** The store's zone (`TZ`): attendance must answer in the same one. */
  timeZone: string;
  eventDays: EventDaysService;
  directory: DirectoryService;
  /** Attendance through the stored connection, or `null` when none is configured. */
  source: () => AttendanceSource | null;
}) {
  const { db, clock, logger, timeZone, eventDays, directory, source } = opts;
  /** Days with a pull waiting on attendance, in this process. */
  const pulling = new Set<number>();

  function editableState(dayId: number) {
    const state = eventDays.importState(dayId);
    if (state.dayState !== 'draft' && state.dayState !== 'open') {
      throw new ServiceError(409, 'day_not_editable', 'Only a day that isn’t closing or closed can be imported into.');
    }
    return { ...state, dayState: state.dayState };
  }

  /** The diff's view of the day: the plan plus the directory rows of every player ID attendance named. */
  function diffOf(dayId: number, day: AttendanceDay): { diff: ImportDiff; planRevision: number; dayState: 'draft' | 'open' } {
    const state = editableState(dayId);
    const playerIds = day.tournaments.flatMap((t) => t.staff.map((s) => s.playerId));
    const importState: ImportState = {
      dayState: state.dayState,
      events: state.events,
      staff: state.staff,
      directory: directory.byPlayerIds(playerIds).map((s) => ({ staffMemberId: s.id, playerId: s.playerId!, displayName: s.displayName, linkState: s.linkState })),
    };
    return { diff: refreshDiff(importState, day), planRevision: state.planRevision, dayState: state.dayState };
  }

  async function read(src: AttendanceSource, date: string): Promise<AttendanceDay> {
    try {
      return await src.getDay(date);
    } catch (err) {
      if (err instanceof AttendanceUnavailableError) throw new ServiceError(503, 'attendance_unavailable', 'Attendance can’t be reached right now. Try again, or enter the day by hand.');
      if (err instanceof AttendanceAuthError) throw new ServiceError(502, 'attendance_token_rejected', 'Attendance refused the token. Mint a new one in attendance and save it in Settings.');
      if (err instanceof AttendanceRateLimitedError) {
        throw new ServiceError(503, 'attendance_rate_limited', 'Attendance asked to wait before the next import.', { retryAfterSeconds: err.retryAfterSeconds });
      }
      if (err instanceof AttendanceRejectedError) throw new ServiceError(502, 'attendance_rejected', 'Attendance refused the read.', { upstreamCode: err.upstreamCode });
      if (err instanceof AttendanceBadResponseError) throw new ServiceError(502, 'attendance_bad_response', 'Attendance’s answer couldn’t be used.', { reason: err.reason });
      throw err;
    }
  }

  return {
    async pull(dayId: number, fetchedBy: string): Promise<Pulled> {
      const date = eventDays.plan(dayId).day.date;
      editableState(dayId);
      const src = source();
      if (!src) throw new ServiceError(409, 'attendance_not_configured', 'Connect attendance in Settings first.');
      if (pulling.has(dayId)) throw new ServiceError(409, 'import_in_progress', 'This day is already being imported.');
      pulling.add(dayId);
      let day: AttendanceDay;
      try {
        day = await read(src, date);
      } finally {
        pulling.delete(dayId);
      }

      const attendanceTimeZone = canonicalTimeZone(day.timeZone) ?? day.timeZone;
      const genieTimeZone = canonicalTimeZone(timeZone) ?? timeZone;
      if (attendanceTimeZone !== genieTimeZone) {
        throw new ServiceError(422, 'timezone_mismatch', 'Attendance and Genie use different time zones.', { attendanceTimeZone, genieTimeZone });
      }
      if (day.professors.length === 0) throw new ServiceError(422, 'no_connected_organizers', 'No professor is connected to attendance.');

      // The plan may have changed while attendance answered: the diff is of the plan as it is now.
      const { diff, planRevision, dayState } = diffOf(dayId, day);
      const snapshotId = randomUUID();
      const fetchedAt = clock.now();
      const values = { snapshotId, payload: JSON.stringify(day), planRevision, dayState, fetchedAt, fetchedBy };
      db.insert(attendanceSnapshot)
        .values({ dayId, ...values })
        .onConflictDoUpdate({ target: attendanceSnapshot.dayId, set: values })
        .run();
      logger.info('Attendance day pulled.', {
        dayId,
        tournaments: day.tournaments.length,
        items: diff.items.length,
        unreadProfessors: diff.unreadProfessors.map((p) => p.playerId),
      });
      return { snapshotId, planRevision, dayState, fetchedAt, diff };
    },

    accept(dayId: number, input: { snapshotId: string; planRevision: number; keys: string[] }): { plan: DayPlanCore; applied: number; syncJobId: number | null } {
      return db.transaction(() => {
        const state = editableState(dayId);
        const snapshot = db.select().from(attendanceSnapshot).where(eq(attendanceSnapshot.dayId, dayId)).get();
        if (!snapshot || snapshot.snapshotId !== input.snapshotId || clock.now() - snapshot.fetchedAt > SNAPSHOT_TTL_MS) {
          throw new ServiceError(409, 'snapshot_stale', 'This import is out of date. Refresh from attendance again.');
        }
        // Opening the day doesn't bump the revision, but a removal means something else on an open day.
        if (input.planRevision !== state.planRevision || snapshot.planRevision !== state.planRevision || snapshot.dayState !== state.dayState) {
          throw new ServiceError(409, 'plan_changed', 'The plan changed since the import was pulled. Refresh from attendance again.');
        }
        const day = JSON.parse(snapshot.payload) as AttendanceDay;
        const { diff } = diffOf(dayId, day);
        const byKey = new Map(diff.items.map((i) => [i.key, i]));
        const keys = [...new Set(input.keys)];
        const unknown = keys.filter((k) => !byKey.has(k));
        if (unknown.length) throw new ServiceError(422, 'unknown_items', 'Some items aren’t in this import.', { keys: unknown });

        const chosen = keys.map((k) => byKey.get(k)!);
        const { ops, applied } = toOps(chosen, diff, snapshot.fetchedAt, (playerId, name) => directory.ensureForImport(playerId, name).id);
        const { syncJobId } = eventDays.applyImport(dayId, ops);
        db.delete(attendanceSnapshot).where(eq(attendanceSnapshot.dayId, dayId)).run();
        logger.info('Attendance import accepted.', { dayId, applied, syncJobId });
        return { plan: eventDays.plan(dayId), applied, syncJobId };
      });
    },
  };
}

/** Turns the chosen items into plan writes. Staff items of an event this accept removes are covered by the removal. */
function toOps(chosen: DiffItem[], diff: ImportDiff, refreshedAt: number, staffIdFor: (playerId: string, name: string) => number): { ops: ImportOps; applied: number } {
  const ops: ImportOps = {
    createEvents: [],
    deleteEvents: [],
    retireEvents: [],
    changeEvents: [],
    addRoles: [],
    removeRoles: [],
    changeRoles: [],
    organizers: diff.organizers,
    refreshedAt,
  };
  const removed = new Set(chosen.flatMap((i) => (i.kind === 'event_removed' ? [i.eventId] : [])));
  let applied = 0;
  for (const item of chosen) {
    if (item.kind !== 'event_added' && item.kind !== 'event_removed' && removed.has(item.eventId)) continue;
    applied += 1;
    switch (item.kind) {
      case 'event_added':
        ops.createEvents.push({
          ...item.event,
          staff: item.staff.map((s) => ({ staffMemberId: s.staffMemberId ?? staffIdFor(s.playerId, s.name), role: s.role })),
        });
        break;
      case 'event_removed':
        (item.effect === 'retire' ? ops.retireEvents : ops.deleteEvents).push(item.eventId);
        break;
      case 'event_changed':
        ops.changeEvents.push({
          eventId: item.eventId,
          ...(item.changes.name ? { name: item.changes.name.to } : {}),
          ...(item.changes.startsAt ? { startsAt: item.changes.startsAt.to } : {}),
          ...(item.changes.tournamentId ? { tournamentId: item.changes.tournamentId.to } : {}),
          ...(item.changes.game ? { game: item.changes.game.to } : {}),
        });
        break;
      case 'staff_added':
        ops.addRoles.push({ eventId: item.eventId, staffMemberId: item.staff.staffMemberId ?? staffIdFor(item.staff.playerId, item.staff.name), role: item.staff.role });
        break;
      case 'staff_removed':
        ops.removeRoles.push({ eventId: item.eventId, staffMemberId: item.staffMemberId });
        break;
      case 'role_changed':
        ops.changeRoles.push({ eventId: item.eventId, staffMemberId: item.staffMemberId, role: item.to });
        break;
    }
  }
  return { ops, applied };
}

export type AttendanceImportService = ReturnType<typeof createAttendanceImportService>;
