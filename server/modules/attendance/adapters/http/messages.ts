/**
 * Attendance's Discord message channel over HTTP (attendance ADR-0015 §7): the long poll and the result route, with a
 * token carrying `messages:deliver`. Redirects are never followed, so the token reaches only these two paths.
 */
import { z } from 'zod';
import { type AttendanceMessages, AttendanceBadResponseError, AttendanceRejectedError, AttendanceUnavailableError, type PolledMessage } from '../../port';
import { parseJson, readCapped, throwUnlessSuccess } from './response';

export interface AttendanceMessagesHttpOptions {
  baseUrl: string;
  token: string;
  /** The most body a poll answer may have. */
  maxBytes: number;
}

/** A poll may wait `wait` seconds on attendance's side; this much more covers the answer's trip. */
const POLL_GRACE_MS = 10_000;
const REPORT_TIMEOUT_MS = 10_000;

// Each message is checked on its own, so one bad message can't hold back the others. Unknown keys are ignored.
const envelope = z.object({ messages: z.array(z.unknown()) });
const messageId = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const message = z.object({
  playerId: z.string().min(1),
  text: z.string().min(1),
  link: z.object({ label: z.string().min(1), url: z.string().min(1) }).nullable(),
  expiresAt: z.iso.datetime(),
});

export function createAttendanceMessagesHttp(opts: AttendanceMessagesHttpOptions): AttendanceMessages {
  const headers = { authorization: `Bearer ${opts.token}`, accept: 'application/json' };

  async function request(url: string, init: RequestInit, signal: AbortSignal, maxBytes: number): Promise<{ response: Response; body: string }> {
    try {
      const response = await fetch(url, { ...init, redirect: 'manual', signal });
      return { response, body: await readCapped(response, maxBytes) };
    } catch (err) {
      if (err instanceof AttendanceBadResponseError) throw err;
      throw new AttendanceUnavailableError('Attendance could not be reached.');
    }
  }

  return {
    async poll({ waitSeconds, limit, signal }) {
      const url = `${opts.baseUrl}/api/integrations/v1/messages?wait=${waitSeconds}&limit=${limit}`;
      const deadline = AbortSignal.timeout(waitSeconds * 1000 + POLL_GRACE_MS);
      const { response, body } = await request(url, { headers }, AbortSignal.any([signal, deadline]), opts.maxBytes);
      throwUnlessSuccess(response, body);
      if (response.status !== 200) throw new AttendanceBadResponseError('unexpected_status');
      const parsed = envelope.safeParse(parseJson(body));
      if (!parsed.success) throw new AttendanceBadResponseError('schema');
      return parsed.data.messages.flatMap(toMessage);
    },

    async report(id, result, signal) {
      const url = `${opts.baseUrl}/api/integrations/v1/messages/${id}/result`;
      const deadline = AbortSignal.timeout(REPORT_TIMEOUT_MS);
      const init: RequestInit = { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(result) };
      const { response, body } = await request(url, init, signal ? AbortSignal.any([signal, deadline]) : deadline, 4096);
      try {
        throwUnlessSuccess(response, body);
      } catch (err) {
        if (err instanceof AttendanceRejectedError && err.status === 404 && err.upstreamCode === 'message_not_found') return 'not_found';
        throw err;
      }
      return 'recorded';
    },
  };
}

/** One wire message: usable, malformed (its ID is usable, the rest isn't), or skipped (no usable ID). */
function toMessage(raw: unknown): PolledMessage[] {
  const id = messageId.safeParse(raw);
  if (!id.success) return [];
  const parsed = message.safeParse(raw);
  if (!parsed.success) return [{ kind: 'malformed', id: id.data.id }];
  const { playerId, text, link, expiresAt } = parsed.data;
  return [{ kind: 'message', id: id.data.id, playerId, text, link: link && { label: link.label, url: link.url }, expiresAt: Date.parse(expiresAt) }];
}
