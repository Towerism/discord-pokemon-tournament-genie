import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AttendanceAuthError,
  AttendanceBadResponseError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  AttendanceUnavailableError,
  type PolledMessage,
} from '../attendance/port';
import type { StaffMember } from '../directory';
import { DiscordAuthError, DiscordPermissionError, DiscordRequestError, DiscordUnavailableError } from '../discord/port';
import { POLL_BUDGET, POLL_WINDOW_MS, afterPoll, decide, dmContent, pollBudgetWait, toResult } from './rules';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const message = (over: Partial<Extract<PolledMessage, { kind: 'message' }>> = {}): PolledMessage => ({
  kind: 'message',
  id: 7,
  playerId: '1234567',
  text: 'You are invited.',
  link: { label: 'Accept', url: 'https://a.example/i/x' },
  expiresAt: NOW + 60_000,
  ...over,
});
const staff = (over: Partial<StaffMember> = {}): StaffMember => ({
  id: 1,
  displayName: 'Ash',
  playerId: '1234567',
  linkState: 'linked',
  discordUserId: '100000000000000001',
  claimedDiscordUserId: null,
  ...over,
});

describe('the DM content', () => {
  it('is the text, a blank line, then the link', () => {
    expect(dmContent('Hi', { label: 'Accept', url: 'https://a.example/i/x' })).toBe('Hi\n\nAccept: https://a.example/i/x');
    expect(dmContent('Hi', null)).toBe('Hi');
  });
});

describe('deciding what to do with a message', () => {
  it('sends a linked staff member the content', () => {
    expect(decide(message(), staff(), NOW)).toEqual({ send: { userId: '100000000000000001', content: 'You are invited.\n\nAccept: https://a.example/i/x' } });
  });

  it('reports no_discord_user without a confirmed link', () => {
    for (const recipient of [null, staff({ linkState: 'claimed', discordUserId: null, claimedDiscordUserId: '100000000000000001' }), staff({ linkState: 'unlinked', discordUserId: null })]) {
      expect(decide(message(), recipient, NOW)).toEqual({ report: { status: 'no_discord_user' } });
    }
    expect(decide(message({ playerId: 'abc' }), staff({ playerId: 'abc' }), NOW)).toEqual({ report: { status: 'no_discord_user' } });
    expect(decide(message({ playerId: '12345678901' }), staff({ playerId: '12345678901' }), NOW)).toEqual({ report: { status: 'no_discord_user' } });
  });

  it('reports no_discord_user, which attendance treats as final, before any retryable failure of the content', () => {
    expect(decide(message({ link: { label: 'x', url: 'javascript:alert(1)' } }), null, NOW)).toEqual({ report: { status: 'no_discord_user' } });
    expect(decide(message({ text: 'T'.repeat(2001), link: null }), null, NOW)).toEqual({ report: { status: 'no_discord_user' } });
  });

  it('fails a malformed or expired message without sending it', () => {
    expect(decide({ kind: 'malformed', id: 7 }, staff(), NOW)).toEqual({ report: { status: 'failed', reason: 'bad_message' } });
    expect(decide(message({ expiresAt: NOW }), staff(), NOW)).toEqual({ report: { status: 'failed', reason: 'expired' } });
    expect(decide(message({ expiresAt: NOW + 1 }), staff(), NOW)).toHaveProperty('send');
  });

  it('fails a link that isn’t http(s)', () => {
    for (const url of ['javascript:alert(1)', 'ftp://a.example/x', '/relative', 'not a url', 'data:text/html,hi']) {
      expect(decide(message({ link: { label: 'x', url } }), staff(), NOW)).toEqual({ report: { status: 'failed', reason: 'invalid_link' } });
    }
    expect(decide(message({ link: { label: 'x', url: 'http://192.168.1.10:3000/invite/x' } }), staff(), NOW)).toHaveProperty('send');
  });

  it('fails content over Discord’s 2,000 characters, and sends it at exactly 2,000', () => {
    const label = 'L'.repeat(60);
    const long = message({ text: 'T'.repeat(1800), link: { label, url: `https://a.example/${'u'.repeat(200)}` } });
    expect(decide(long, staff(), NOW)).toEqual({ report: { status: 'failed', reason: 'too_long' } });
    const exact = 'https://a.example/'.length;
    // text + "\n\n" + label + ": " + url = 2,000
    const url = `https://a.example/${'u'.repeat(2000 - 1800 - 2 - 60 - 2 - exact)}`;
    expect(dmContent('T'.repeat(1800), { label, url })).toHaveLength(2000);
    expect(decide(message({ text: 'T'.repeat(1800), link: { label, url } }), staff(), NOW)).toHaveProperty('send');
    expect(decide(message({ text: 'T'.repeat(1800), link: { label, url: `https://a.example/${'u'.repeat(100)}` } }), staff(), NOW)).toHaveProperty('send');
  });
});

describe('turning Discord’s answer into a result', () => {
  it('maps each answer', () => {
    expect(toResult('sent')).toEqual({ status: 'delivered' });
    expect(toResult('refused')).toEqual({ status: 'dm_refused' });
    expect(toResult('unknown_user')).toEqual({ status: 'no_discord_user' });
    expect(toResult({ error: new DiscordAuthError('x') })).toEqual({ status: 'failed', reason: 'discord_auth' });
    expect(toResult({ error: new DiscordUnavailableError('x') })).toEqual({ status: 'failed', reason: 'discord_unavailable' });
    expect(toResult({ error: new DiscordRequestError(400, 50035) })).toEqual({ status: 'failed', reason: 'discord_50035' });
    expect(toResult({ error: new DiscordPermissionError('x') })).toEqual({ status: 'failed', reason: 'discord_50013' });
    expect(toResult({ error: new Error('boom') })).toEqual({ status: 'failed', reason: 'internal_error' });
  });

  it('never puts anything but a plain code in the reason', () => {
    expect(toResult({ error: new DiscordRequestError(400, 'secret <@1> text') })).toEqual({ status: 'failed', reason: 'discord_request' });
  });
});

describe('when to poll next', () => {
  const fresh = { failures: 0 };
  const answered = (startedAt: number, messages: number) => ({ kind: 'answered' as const, startedAt, messages });
  const failed = (error: unknown) => ({ kind: 'failed' as const, error });

  it('polls again at once after messages or a full wait, and pauses after an empty answer that came back fast', () => {
    expect(afterPoll(fresh, answered(NOW - 1000, 2), NOW)).toEqual({ state: 'polling', waitMs: 0, failures: 0 });
    expect(afterPoll(fresh, answered(NOW - 25_000, 0), NOW)).toEqual({ state: 'polling', waitMs: 0, failures: 0 });
    expect(afterPoll(fresh, answered(NOW - 1000, 0), NOW)).toEqual({ state: 'polling', waitMs: 4000, failures: 0 });
    expect(afterPoll({ failures: 3 }, answered(NOW - 5000, 0), NOW)).toEqual({ state: 'polling', waitMs: 0, failures: 0 });
  });

  it('follows the failure table', () => {
    const rows: [unknown, string, number][] = [
      [new AttendanceAuthError('x'), 'token_refused', 300_000],
      [new AttendanceRejectedError('insufficient_scope', 403), 'missing_scope', 300_000],
      [new AttendanceRejectedError('not_found', 404), 'unsupported', 300_000],
      [new AttendanceRejectedError(null, 404), 'unsupported', 300_000],
      [new AttendanceRateLimitedError(120), 'rate_limited', 120_000],
      [new AttendanceRejectedError('shutting_down', 503), 'attendance_unreachable', 5000],
      [new AttendanceRejectedError(null, 400), 'rejected', 300_000],
      [new AttendanceRejectedError('forbidden', 403), 'rejected', 300_000],
      [new AttendanceRejectedError('professor_unidentified', 503), 'attendance_unreachable', 5000],
      [new AttendanceUnavailableError('x'), 'attendance_unreachable', 5000],
      [new AttendanceBadResponseError('redirect'), 'attendance_unreachable', 5000],
      [new Error('unexpected'), 'attendance_unreachable', 5000],
    ];
    for (const [error, state, waitMs] of rows) expect(afterPoll(fresh, failed(error), NOW)).toMatchObject({ state, waitMs });
  });

  it('doubles the outage wait up to 60 s, and the doubling resets after an answer', () => {
    let history = { failures: 0 };
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const next = afterPoll(history, failed(new AttendanceUnavailableError('x')), NOW);
      waits.push(next.waitMs);
      history = { failures: next.failures };
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(afterPoll(history, answered(NOW - 30_000, 0), NOW).failures).toBe(0);
    expect(afterPoll(history, failed(new AttendanceRejectedError('shutting_down', 503)), NOW).waitMs).toBe(5000);
  });
});

describe('the poll budget', () => {
  it('lets 110 polls start in 15 minutes, then waits until the oldest leaves the window', () => {
    const starts = Array.from({ length: POLL_BUDGET }, (_, i) => NOW - POLL_WINDOW_MS + 1000 + i * 1000);
    expect(pollBudgetWait(starts.slice(1), NOW)).toBe(0);
    expect(pollBudgetWait(starts, NOW)).toBe(1000);
    expect(pollBudgetWait([NOW - POLL_WINDOW_MS - 1, ...starts.slice(1)], NOW)).toBe(0);
  });

  it('never starts two polls closer than 5 s, nor more than 110 in any 15 minutes, when every answer is empty and fast', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 4999 }), { minLength: 50, maxLength: 400 }), (latencies) => {
        let now = NOW;
        let history = { failures: 0 };
        const starts: number[] = [];
        for (const latency of latencies) {
          now += pollBudgetWait(starts, now);
          starts.push(now);
          now += latency;
          const next = afterPoll(history, { kind: 'answered', startedAt: starts.at(-1)!, messages: 0 }, now);
          history = { failures: next.failures };
          now += next.waitMs;
        }
        for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(5000);
        for (let i = POLL_BUDGET; i < starts.length; i++) expect(starts[i]! - starts[i - POLL_BUDGET]!).toBeGreaterThanOrEqual(POLL_WINDOW_MS);
      }),
      { seed: 51, numRuns: 200 },
    );
  });
});
