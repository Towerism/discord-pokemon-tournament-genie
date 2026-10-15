import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeAttendanceHttp, startFakeAttendanceHttp } from '../../../../../test/support/fake-attendance-http';
import {
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  AttendanceUnavailableError,
} from '../../port';
import { createAttendanceHttp } from '.';

const TOKEN = `ppa_int_${'b'.repeat(39)}Zx9_`;
const DATE = '2026-10-17';
const MAX = 64 * 1024;

let http: FakeAttendanceHttp;
beforeAll(async () => {
  http = await startFakeAttendanceHttp({ token: TOKEN });
});
afterAll(() => http.close());
afterEach(() => {
  http.raw.clear();
  http.requests.length = 0;
});

const adapter = (over: Partial<Parameters<typeof createAttendanceHttp>[0]> = {}) =>
  createAttendanceHttp({ baseUrl: http.url, token: TOKEN, timeoutMs: 5_000, maxBytes: MAX, ...over });

/** The rejection, checked to carry no secret in its message. */
async function failure(promise: Promise<unknown>): Promise<Error> {
  const err = await promise.then(
    () => {
      throw new Error('expected the read to fail');
    },
    (e: unknown) => e as Error,
  );
  expect(err.message).not.toContain(TOKEN);
  return err;
}

const day = (over: Record<string, unknown> = {}) => ({ date: DATE, timezone: 'America/Chicago', tournaments: [], professors: [], ...over });
const tournament = (id: string) => ({
  id,
  name: 'Cup',
  displayId: null,
  startsAt: '2026-10-17T15:00:00.000Z',
  game: 'tcg',
  organizer: { playerId: '1', name: 'Oak' },
  staff: [],
});

describe('the attendance HTTP adapter', () => {
  it('sends the token as a bearer to the v1 day path, and nowhere else', async () => {
    await adapter().getDay(DATE);
    expect(http.requests).toEqual([{ path: `/api/integrations/v1/days/${DATE}`, authorization: true, tokenMatched: true }]);
  });

  it('is unavailable when attendance can’t be reached, answers 500, or doesn’t answer in time', async () => {
    const closed = await startFakeAttendanceHttp({ token: TOKEN });
    const deadUrl = closed.url;
    await closed.close();
    expect(await failure(adapter({ baseUrl: deadUrl }).getDay(DATE))).toBeInstanceOf(AttendanceUnavailableError);

    http.next({ kind: 'server_error' });
    expect(await failure(adapter().getDay(DATE))).toBeInstanceOf(AttendanceUnavailableError);

    http.next({ kind: 'hang' });
    expect(await failure(adapter({ timeoutMs: 50 }).getDay(DATE))).toBeInstanceOf(AttendanceUnavailableError);
  });

  it('reports a refused token', async () => {
    expect(await failure(adapter({ token: `ppa_int_${'c'.repeat(43)}` }).getDay(DATE))).toBeInstanceOf(AttendanceAuthError);
  });

  it('passes on how long attendance asks to wait, 60 s when it doesn’t say', async () => {
    http.next({ kind: 'rate_limited', retryAfter: '30' }, { kind: 'rate_limited' }, { kind: 'rate_limited', retryAfter: 'soon' });
    for (const expected of [30, 60, 60]) {
      const err = await failure(adapter().getDay(DATE));
      expect(err).toBeInstanceOf(AttendanceRateLimitedError);
      expect((err as AttendanceRateLimitedError).retryAfterSeconds).toBe(expected);
    }
  });

  it('passes on attendance’s own reason, for a 4xx and for a 5xx that carries one', async () => {
    http.next({ kind: 'league_not_selected' }, { kind: 'professor_unidentified' });
    for (const code of ['league_not_selected', 'professor_unidentified']) {
      const err = await failure(adapter().getDay(DATE));
      expect(err).toBeInstanceOf(AttendanceRejectedError);
      expect((err as AttendanceRejectedError).upstreamCode).toBe(code);
    }
  });

  it('never follows a redirect, so the token never reaches the target', async () => {
    http.next({ kind: 'redirect' });
    const err = await failure(adapter().getDay(DATE));
    expect(err).toBeInstanceOf(AttendanceBadResponseError);
    expect((err as AttendanceBadResponseError).reason).toBe('redirect');
    expect(http.requests.filter((r) => r.path === '/elsewhere')).toEqual([]);
  });

  it.each([
    ['too_large', () => http.next({ kind: 'oversize', bytes: MAX + 1 })],
    ['not_json', () => http.next({ kind: 'malformed' })],
    ['schema', () => http.raw.set(DATE, { date: DATE, timezone: 'America/Chicago', tournaments: [] })],
    ['date_mismatch', () => http.raw.set(DATE, day({ date: '2026-10-18' }))],
    ['duplicate_tournament', () => http.raw.set(DATE, day({ tournaments: [tournament('t1'), tournament('t1')] }))],
    ['schema', () => http.raw.set(DATE, day({ tournaments: [tournament('x'.repeat(58))] }))],
    ['schema', () => http.raw.set(DATE, day({ tournaments: [{ ...tournament('t1'), startsAt: 'Saturday' }] }))],
    // Streaming is Genie's own role (ADR-0015): attendance never sends it.
    ['schema', () => http.raw.set(DATE, day({ tournaments: [{ ...tournament('t1'), staff: [{ playerId: '2', name: 'Brock', role: 'streaming' }] }] }))],
    ['invalid_time_zone', () => http.raw.set(DATE, day({ timezone: 'Mars/Base' }))],
  ])('refuses an unusable answer (%s)', async (reason, arrange) => {
    arrange();
    const err = await failure(adapter().getDay(DATE));
    expect(err).toBeInstanceOf(AttendanceBadResponseError);
    expect((err as AttendanceBadResponseError).reason).toBe(reason);
  });

  it('accepts a 57-character tournament ID, the longest a diff key holds', async () => {
    http.raw.set(DATE, day({ tournaments: [tournament('x'.repeat(57))] }));
    expect((await adapter().getDay(DATE)).tournaments).toHaveLength(1);
  });

  it('drops an error code that isn’t a plain code instead of passing it on', async () => {
    const odd = await serveOnce(418, JSON.stringify({ data: { code: '<script>' } }));
    const err = await failure(adapter({ baseUrl: odd.url }).getDay(DATE));
    await odd.close();
    expect((err as AttendanceRejectedError).upstreamCode).toBeNull();
  });

  it('refuses a success that isn’t 200', async () => {
    const odd = await serveOnce(204, '');
    const err = await failure(adapter({ baseUrl: odd.url }).getDay(DATE));
    await odd.close();
    expect((err as AttendanceBadResponseError).reason).toBe('unexpected_status');
  });

  it('refuses a body larger than the cap even without a content length', async () => {
    const big = await serveOnce(200, `"${'y'.repeat(MAX)}"`, { chunked: true });
    const err = await failure(adapter({ baseUrl: big.url }).getDay(DATE));
    await big.close();
    expect((err as AttendanceBadResponseError).reason).toBe('too_large');
  });
});

/** A server answering every request with one status and body. */
async function serveOnce(status: number, body: string, opts: { chunked?: boolean } = {}) {
  const sockets = new Set<Socket>();
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    if (opts.chunked) {
      // Two writes without a content length: the cap must hold on the stream itself.
      res.write(body.slice(0, body.length / 2));
      res.end(body.slice(body.length / 2));
    } else res.end(body);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
