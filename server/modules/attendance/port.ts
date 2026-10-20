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

/**
 * One message from attendance's Discord channel (attendance ADR-0015 §7). `malformed`: its `id` is usable but the
 * rest isn't, so Genie reports it failed without sending it.
 */
export type PolledMessage =
  | { kind: 'message'; id: number; playerId: string; text: string; link: { label: string; url: string } | null; expiresAt: number }
  | { kind: 'malformed'; id: number };

/** What Genie reports for a message. The first three are final in attendance; `failed` is retried there. */
export type MessageResult = { status: 'delivered' | 'no_discord_user' | 'dm_refused' } | { status: 'failed'; reason: string };

/** The other half of attendance's channel: hand out messages to send, take back what happened to each. */
export interface AttendanceMessages {
  /**
   * The long poll: answers as soon as attendance has a message to hand out, or after `waitSeconds` with none.
   * @throws AttendanceAuthError | AttendanceRateLimitedError | AttendanceRejectedError | AttendanceUnavailableError | AttendanceBadResponseError
   */
  poll(opts: { waitSeconds: number; limit: number; signal: AbortSignal }): Promise<PolledMessage[]>;
  /** `not_found` for attendance's 404 `message_not_found`; otherwise throws as `poll` does. */
  report(id: number, result: MessageResult, signal?: AbortSignal): Promise<'recorded' | 'not_found'>;
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
  constructor(
    readonly upstreamCode: string | null,
    readonly status: number,
  ) {
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
