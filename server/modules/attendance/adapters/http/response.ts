/**
 * Reading attendance's answers, shared by the day read and the message channel: a capped body, h3's error codes and
 * the status → port error mapping. Nothing upstream is passed on but a plain error code.
 */
import {
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  AttendanceUnavailableError,
} from '../../port';

const UPSTREAM_CODE = /^[a-z_]{1,64}$/;
const DEFAULT_RETRY_AFTER_SECONDS = 60;

/** Reads at most `maxBytes`, cancelling the stream past it. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
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
export function errorCode(body: string): string | null {
  try {
    const code = (JSON.parse(body) as { data?: { code?: unknown } } | null)?.data?.code;
    return typeof code === 'string' && UPSTREAM_CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AttendanceBadResponseError('not_json');
  }
}

/**
 * Throws the port's error for anything but a 2xx: a 3xx is never followed, 401 is the token, 429 waits, a 5xx without
 * a code is an outage, and any other refusal carries attendance's code and status.
 */
export function throwUnlessSuccess(response: Response, body: string): void {
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
  if (status < 200) throw new AttendanceBadResponseError('unexpected_status');
}
