/**
 * An in-memory attendance behind the `AttendanceSource` port, for integration tests. Each fake holds its own state:
 * days by date, failures for the next calls, a gate that holds calls mid-flight, and a call count.
 */
import {
  type AttendanceDay,
  type AttendanceMessages,
  type MessageResult,
  type PolledMessage,
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  type AttendanceSource,
  AttendanceUnavailableError,
} from '../port';

export type AttendanceFailure =
  | { kind: 'unavailable' }
  | { kind: 'auth' }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'rejected'; upstreamCode: string | null }
  | { kind: 'bad_response' };

export interface FakeAttendance extends AttendanceSource {
  /** Days by date. A date without an entry answers an empty day with no professors. */
  readonly days: Map<string, AttendanceDay>;
  /** How many reads reached the fake. */
  calls: number;
  /** While set, every read waits for it: lets a test hold a pull mid-flight. */
  gate: Promise<void> | null;
  /** The next reads fail this way, one per entry. */
  failNext(...failures: AttendanceFailure[]): void;
}

export function createFakeAttendance(): FakeAttendance {
  const failures: AttendanceFailure[] = [];
  const fake: FakeAttendance = {
    days: new Map(),
    calls: 0,
    gate: null,
    failNext(...next) {
      failures.push(...next);
    },
    async getDay(date) {
      fake.calls += 1;
      await fake.gate;
      const failure = failures.shift();
      if (failure) throw toError(failure);
      // A copy, so a caller can't change the fake's state through the answer.
      return structuredClone(fake.days.get(date) ?? { date, timeZone: 'America/Chicago', tournaments: [], professors: [] });
    },
  };
  return fake;
}

export interface FakeAttendanceMessages extends AttendanceMessages {
  /** What the next poll hands out, oldest first; a handed-out message leaves the queue. */
  readonly queue: PolledMessage[];
  /** Every result reported, in order, as attendance would receive it. */
  readonly results: { id: number; body: MessageResult }[];
  /** The next polls fail this way, one per entry. */
  failNext(...failures: AttendanceFailure[]): void;
}

/** An in-memory message channel: a poll answers at once with what is queued, never waiting. */
export function createFakeAttendanceMessages(): FakeAttendanceMessages {
  const failures: AttendanceFailure[] = [];
  const fake: FakeAttendanceMessages = {
    queue: [],
    results: [],
    failNext(...next) {
      failures.push(...next);
    },
    async poll({ limit }) {
      const failure = failures.shift();
      if (failure) throw toError(failure);
      return structuredClone(fake.queue.splice(0, limit));
    },
    async report(id, result) {
      fake.results.push({ id, body: structuredClone(result) });
      return 'recorded';
    },
  };
  return fake;
}

function toError(failure: AttendanceFailure): Error {
  switch (failure.kind) {
    case 'unavailable':
      return new AttendanceUnavailableError('Attendance is down (fake).');
    case 'auth':
      return new AttendanceAuthError('Attendance refused the token (fake).');
    case 'rate_limited':
      return new AttendanceRateLimitedError(failure.retryAfterSeconds);
    case 'rejected':
      return new AttendanceRejectedError(failure.upstreamCode, 409);
    case 'bad_response':
      return new AttendanceBadResponseError('schema');
  }
}
