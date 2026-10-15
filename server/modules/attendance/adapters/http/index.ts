/**
 * Attendance's v1 day endpoint over HTTP (ADR-0008, attendance #115). The only code that calls attendance (§3).
 * The token goes to `{baseUrl}/api/integrations/v1/days/{date}` and nowhere else: redirects are never followed.
 */
import { z } from 'zod';
import {
  type AttendanceDay,
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  type AttendanceSource,
  AttendanceUnavailableError,
  EVENT_ROLES,
  canonicalTimeZone,
} from '../../port';

export interface AttendanceHttpOptions {
  baseUrl: string;
  token: string;
  /** Attendance reads play-tools live, once per professor, so a day can take a while. */
  timeoutMs: number;
  /** The most body read before giving up. */
  maxBytes: number;
}

/** Diff keys embed the tournament ID and stay within 64 characters (`event+:` is 7). */
const MAX_TOURNAMENT_ID = 57;
const UPSTREAM_CODE = /^[a-z_]{1,64}$/;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

// v1's wire shape. Unknown keys are ignored, so attendance can add fields without breaking Genie.
const wirePerson = z.object({ playerId: z.string().min(1), name: z.string() });
const wireDay = z.object({
  date: z.string(),
  timezone: z.string(),
  tournaments: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string(),
      displayId: z.string().nullable(),
      startsAt: z.string(),
      game: z.enum(['tcg', 'vgc', 'go']).nullable(),
      organizer: wirePerson,
      staff: z.array(wirePerson.extend({ role: z.enum(EVENT_ROLES) })),
    }),
  ),
  professors: z.array(
    wirePerson.extend({ status: z.enum(['read', 'unread']), reason: z.enum(['needs_reconnect', 'read_failed']).optional() }),
  ),
});
type WireDay = z.infer<typeof wireDay>;

export function createAttendanceHttp(opts: AttendanceHttpOptions): AttendanceSource {
  return {
    async getDay(date) {
      const url = `${opts.baseUrl}/api/integrations/v1/days/${encodeURIComponent(date)}`;
      let response: Response;
      let body: string;
      try {
        response = await fetch(url, {
          headers: { authorization: `Bearer ${opts.token}`, accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        body = await readCapped(response, opts.maxBytes);
      } catch (err) {
        if (err instanceof AttendanceBadResponseError) throw err;
        throw new AttendanceUnavailableError('Attendance could not be reached.');
      }
      const { status } = response;
      if (status >= 300 && status < 400) throw new AttendanceBadResponseError('redirect');
      if (status === 401) throw new AttendanceAuthError('Attendance refused the token.');
      if (status === 429) throw new AttendanceRateLimitedError(retryAfter(response.headers.get('retry-after')));
      if (status >= 500) {
        const code = errorCode(body);
        if (code) throw new AttendanceRejectedError(code, status);
        throw new AttendanceUnavailableError(`Attendance answered ${status}.`);
      }
      if (status >= 400) throw new AttendanceRejectedError(errorCode(body), status);
      if (status !== 200) throw new AttendanceBadResponseError('unexpected_status');
      return toDay(date, parseJson(body));
    },
  };
}

/** Reads at most `maxBytes`, cancelling the stream past it. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new AttendanceBadResponseError('too_large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AttendanceBadResponseError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function retryAfter(header: string | null): number {
  const seconds = Number(header);
  return header !== null && /^\d+$/.test(header.trim()) && Number.isSafeInteger(seconds) ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

/** h3's error body carries `data.code`; anything that isn't a plain code is dropped, never echoed. */
function errorCode(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { data?: { code?: unknown } } | null)?.data?.code;
    return typeof code === 'string' && UPSTREAM_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AttendanceBadResponseError('not_json');
  }
}

function toDay(date: string, json: unknown): AttendanceDay {
  const parsed = wireDay.safeParse(json);
  if (!parsed.success) throw new AttendanceBadResponseError('schema');
  const wire: WireDay = parsed.data;
  if (wire.date !== date) throw new AttendanceBadResponseError('date_mismatch');
  const timeZone = canonicalTimeZone(wire.timezone);
  if (!timeZone) throw new AttendanceBadResponseError('invalid_time_zone');
  const ids = new Set<string>();
  const tournaments = wire.tournaments.map((t) => {
    if (ids.has(t.id)) throw new AttendanceBadResponseError('duplicate_tournament');
    if (t.id.length > MAX_TOURNAMENT_ID) throw new AttendanceBadResponseError('schema');
    ids.add(t.id);
    const startsAt = Date.parse(t.startsAt);
    if (!Number.isFinite(startsAt)) throw new AttendanceBadResponseError('schema');
    return {
      id: t.id,
      name: t.name,
      displayId: t.displayId,
      startsAt,
      game: t.game,
      organizer: { playerId: t.organizer.playerId, name: t.organizer.name },
      staff: t.staff.map((s) => ({ playerId: s.playerId, name: s.name, role: s.role })),
    };
  });
  const professors = wire.professors.map((p) =>
    p.status === 'read'
      ? { playerId: p.playerId, name: p.name, status: 'read' as const }
      : { playerId: p.playerId, name: p.name, status: 'unread' as const, reason: p.reason ?? ('read_failed' as const) },
  );
  return { date: wire.date, timeZone, tournaments, professors };
}
