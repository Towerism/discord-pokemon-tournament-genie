/**
 * The attendance side of ADR-0008: one read of a day's tournaments and staff, for every professor connected to
 * attendance. Only `adapters/http` talks to attendance; these are Genie's types, not the wire's (§3).
 */

export const EVENT_ROLES = ['headjudge', 'judge', 'scorekeeper', 'administration', 'translator'] as const;
export type AttendanceRole = (typeof EVENT_ROLES)[number];
export type AttendanceGame = 'tcg' | 'vgc' | 'go' | null;
export type UnreadReason = 'needs_reconnect' | 'read_failed';

export type ProfessorStatus = { playerId: string; name: string } & ({ status: 'read' } | { status: 'unread'; reason: UnreadReason });

export interface AttendanceTournament {
  /** Attendance's tournament GUID. */
  id: string;
  name: string;
  /** play-tools' display ID (`25-10-000123`), when attendance knows it. */
  displayId: string | null;
  /** Epoch ms. */
  startsAt: number;
  game: AttendanceGame;
  /** The connected professor it was read as. */
  organizer: { playerId: string; name: string };
  staff: { playerId: string; name: string; role: AttendanceRole }[];
}

export interface AttendanceDay {
  /** Store-TZ `YYYY-MM-DD`, as asked for. */
  date: string;
  /** Attendance's league zone, canonical IANA name. */
  timeZone: string;
  tournaments: AttendanceTournament[];
  /** Every connected professor, with whether this read could reach them. */
  professors: ProfessorStatus[];
}

export interface AttendanceSource {
  getDay(date: string): Promise<AttendanceDay>;
}

/** Network error, timeout, or a 5xx without an error code: worth retrying later. */
export class AttendanceUnavailableError extends Error {
  override name = 'AttendanceUnavailableError';
}
/** Attendance refused the token (401). */
export class AttendanceAuthError extends Error {
  override name = 'AttendanceAuthError';
}
/** Attendance's per-token limit (429). */
export class AttendanceRateLimitedError extends Error {
  override name = 'AttendanceRateLimitedError';
  constructor(readonly retryAfterSeconds: number) {
    super(`Attendance asked to wait ${retryAfterSeconds} s.`);
  }
}
/** Attendance answered with a reason of its own (another 4xx, or a 5xx with a code such as `professor_unidentified`). */
export class AttendanceRejectedError extends Error {
  override name = 'AttendanceRejectedError';
  constructor(readonly upstreamCode: string | null, status: number) {
    super(`Attendance refused the read (${status}${upstreamCode ? `, ${upstreamCode}` : ''}).`);
  }
}

export const BAD_RESPONSE_REASONS = [
  'redirect',
  'not_json',
  'too_large',
  'schema',
  'date_mismatch',
  'duplicate_tournament',
  'invalid_time_zone',
  'unexpected_status',
] as const;
export type BadResponseReason = (typeof BAD_RESPONSE_REASONS)[number];

/** The answer can't be trusted; nothing upstream is passed on but the reason. */
export class AttendanceBadResponseError extends Error {
  override name = 'AttendanceBadResponseError';
  constructor(readonly reason: BadResponseReason) {
    super(`Attendance's answer was unusable (${reason}).`);
  }
}

/** The canonical name of an IANA zone, or `null` when `Intl` doesn't know it. Node folds some aliases, not all. */
export function canonicalTimeZone(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
