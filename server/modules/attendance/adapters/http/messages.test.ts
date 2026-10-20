import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type FakeAttendanceHttp, startFakeAttendanceHttp } from '../../../../../test/support/fake-attendance-http';
import {
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  AttendanceUnavailableError,
} from '../../port';
import { createAttendanceMessagesHttp } from './messages';

const TOKEN = `ppa_int_${'p'.repeat(43)}`;
const wire = (id: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  playerId: '1234567',
  text: 'Hello',
  link: { label: 'Open', url: 'https://a.example/x' },
  expiresAt: '2026-10-23T15:04:05.000Z',
  ...extra,
});

let http: FakeAttendanceHttp;
beforeAll(async () => {
  http = await startFakeAttendanceHttp({ token: TOKEN });
});
afterAll(() => http.close());
beforeEach(() => {
  http.queue.length = 0;
  http.results.length = 0;
  http.polls.length = 0;
});

const adapter = (token = TOKEN) => createAttendanceMessagesHttp({ baseUrl: http.url, token, maxBytes: 4096 });
const poll = (signal = new AbortController().signal, token?: string) => adapter(token).poll({ waitSeconds: 25, limit: 20, signal });

describe('polling attendance for messages', () => {
  it('asks with the token, the wait and the limit', async () => {
    http.queue.push(wire(1));
    await poll();
    expect(http.polls).toEqual([{ wait: '25', limit: '20', tokenMatched: true, aborted: false }]);
  });

  it('keeps each message on its own: a bad one is malformed, one without a usable id is skipped, unknown keys are ignored', async () => {
    http.queue.push(wire(1, { extra: 'ignored' }), wire(2, { text: '' }), wire(3, { link: { label: 'x' } }), wire(0), wire('4'), 'nonsense', wire(5, { expiresAt: 'soon' }), wire(6, { link: null }));
    expect(await poll()).toEqual([
      { kind: 'message', id: 1, playerId: '1234567', text: 'Hello', link: { label: 'Open', url: 'https://a.example/x' }, expiresAt: Date.parse('2026-10-23T15:04:05.000Z') },
      { kind: 'malformed', id: 2 },
      { kind: 'malformed', id: 3 },
      { kind: 'malformed', id: 5 },
      { kind: 'message', id: 6, playerId: '1234567', text: 'Hello', link: null, expiresAt: Date.parse('2026-10-23T15:04:05.000Z') },
    ]);
  });

  it('refuses an answer it can’t trust', async () => {
    http.nextPoll({ kind: 'redirect' }, { kind: 'not_json' }, { kind: 'oversize', bytes: 8192 }, { kind: 'body', body: { messages: 'none' } }, { kind: 'status', status: 204 });
    for (const reason of ['redirect', 'not_json', 'too_large', 'schema', 'unexpected_status']) {
      await expect(poll()).rejects.toSatisfy((err) => err instanceof AttendanceBadResponseError && err.reason === reason);
    }
  });

  it('maps attendance’s refusals to the port’s errors', async () => {
    await expect(poll(undefined, 'ppa_int_wrong')).rejects.toBeInstanceOf(AttendanceAuthError);
    http.nextPoll(
      { kind: 'status', status: 403, code: 'insufficient_scope' },
      { kind: 'status', status: 404, code: 'not_found' },
      { kind: 'status', status: 400 },
      { kind: 'status', status: 503, code: 'shutting_down' },
    );
    for (const [status, code] of [
      [403, 'insufficient_scope'],
      [404, 'not_found'],
      [400, null],
      [503, 'shutting_down'],
    ] as const) {
      await expect(poll()).rejects.toSatisfy((err) => err instanceof AttendanceRejectedError && err.status === status && err.upstreamCode === code);
    }
    http.nextPoll({ kind: 'status', status: 429, retryAfter: '120' }, { kind: 'status', status: 429 }, { kind: 'status', status: 502 });
    await expect(poll()).rejects.toSatisfy((err) => err instanceof AttendanceRateLimitedError && err.retryAfterSeconds === 120);
    await expect(poll()).rejects.toSatisfy((err) => err instanceof AttendanceRateLimitedError && err.retryAfterSeconds === 60);
    await expect(poll()).rejects.toBeInstanceOf(AttendanceUnavailableError);
  });

  it('gives up a held poll when its signal aborts, and attendance sees the client go', async () => {
    const controller = new AbortController();
    const held = poll(controller.signal);
    await http.pollWaiting();
    controller.abort();
    await expect(held).rejects.toBeInstanceOf(AttendanceUnavailableError);
    await expect.poll(() => http.polls[0]?.aborted).toBe(true);
  });

  it('answers a held poll as soon as a message is queued', async () => {
    const held = poll();
    await http.pollWaiting();
    http.deliver(wire(9));
    expect((await held).map((m) => m.id)).toEqual([9]);
  });
});

describe('reporting a message’s result', () => {
  it('posts the status, and the reason only for a failure', async () => {
    expect(await adapter().report(7, { status: 'dm_refused' })).toBe('recorded');
    expect(await adapter().report(8, { status: 'failed', reason: 'expired' })).toBe('recorded');
    expect(http.results).toEqual([
      { id: 7, body: { status: 'dm_refused' } },
      { id: 8, body: { status: 'failed', reason: 'expired' } },
    ]);
  });

  it('answers not_found for a message attendance doesn’t have, and throws as a poll does otherwise', async () => {
    http.nextResult({ status: 404, code: 'message_not_found' }, { status: 404 }, { status: 429, retryAfter: '5' }, { status: 500 }, { status: 401 });
    expect(await adapter().report(7, { status: 'delivered' })).toBe('not_found');
    await expect(adapter().report(7, { status: 'delivered' })).rejects.toSatisfy((err) => err instanceof AttendanceRejectedError && err.status === 404);
    await expect(adapter().report(7, { status: 'delivered' })).rejects.toSatisfy((err) => err instanceof AttendanceRateLimitedError && err.retryAfterSeconds === 5);
    await expect(adapter().report(7, { status: 'delivered' })).rejects.toBeInstanceOf(AttendanceUnavailableError);
    await expect(adapter().report(7, { status: 'delivered' })).rejects.toBeInstanceOf(AttendanceAuthError);
    expect(http.results).toEqual([]);
  });
});
