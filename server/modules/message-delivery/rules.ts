/**
 * The decisions behind delivering attendance's messages (issue #51, ADR-0017), as pure functions: whether a message is
 * sent and to whom, what Discord's answer means for attendance, and when to poll next.
 */
import type { DeliveryState } from '../../../shared/delivery';
import {
  AttendanceAuthError,
  AttendanceRateLimitedError,
  AttendanceRejectedError,
  type MessageResult,
  type PolledMessage,
} from '../attendance/port';
import { PLAYER_ID, type StaffMember } from '../directory';
import { DiscordAuthError, DiscordPermissionError, DiscordRequestError, DiscordUnavailableError } from '../discord/port';

/** Discord's limit on a message's content. */
export const MAX_CONTENT = 2000;
/** An empty answer that came back sooner than this means attendance didn't wait; the next poll waits out the rest. */
export const MIN_EMPTY_POLL_MS = 5000;
/** Attendance allows 120 polls per 15 minutes per token; Genie keeps 10 in hand. */
export const POLL_BUDGET = 110;
export const POLL_WINDOW_MS = 15 * 60_000;
/** A refusal the organizer has to fix is asked again this often. */
export const REFUSED_RETRY_MS = 5 * 60_000;
const OUTAGE_FIRST_MS = 5000;
const OUTAGE_MAX_MS = 60_000;

export type { DeliveryState };

/** What the DM says: the text, then the link (attendance ADR-0015 §7). */
export function dmContent(text: string, link: { label: string; url: string } | null): string {
  return link ? `${text}\n\n${link.label}: ${link.url}` : text;
}

export type Decision = { send: { userId: string; content: string } } | { report: MessageResult };

/**
 * A message's fate before any send. Only a staff member the organizer linked gets one: a `/link` claim is unconfirmed,
 * and an invite link is a secret.
 */
export function decide(message: PolledMessage, recipient: StaffMember | null, now: number): Decision {
  if (message.kind === 'malformed') return failed('bad_message');
  if (message.expiresAt <= now) return failed('expired');
  if (message.link && !isWebUrl(message.link.url)) return failed('invalid_link');
  const content = dmContent(message.text, message.link);
  if (content.length > MAX_CONTENT) return failed('too_long');
  if (!PLAYER_ID.test(message.playerId) || recipient?.linkState !== 'linked' || !recipient.discordUserId) return { report: { status: 'no_discord_user' } };
  return { send: { userId: recipient.discordUserId, content } };
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const failed = (reason: string): Decision => ({ report: { status: 'failed', reason } });

/** What Discord's answer to the send means for attendance. A reason is only ever a plain code. */
export function toResult(outcome: 'sent' | 'refused' | 'unknown_user' | { error: unknown }): MessageResult {
  if (outcome === 'sent') return { status: 'delivered' };
  if (outcome === 'refused') return { status: 'dm_refused' };
  if (outcome === 'unknown_user') return { status: 'no_discord_user' };
  const { error } = outcome;
  if (error instanceof DiscordAuthError) return { status: 'failed', reason: 'discord_auth' };
  if (error instanceof DiscordUnavailableError) return { status: 'failed', reason: 'discord_unavailable' };
  if (error instanceof DiscordPermissionError) return { status: 'failed', reason: `discord_${error.code}` };
  if (error instanceof DiscordRequestError) return { status: 'failed', reason: /^\d{1,10}$/.test(String(error.code)) ? `discord_${error.code}` : 'discord_request' };
  return { status: 'failed', reason: 'internal_error' };
}

export type PollOutcome = { kind: 'answered'; startedAt: number; messages: number } | { kind: 'failed'; error: unknown };

/**
 * The state a poll leaves, and how long to wait before the next (ADR-0017's limits): a refusal the organizer must fix
 * waits 5 min, a 429 its `Retry-After`, an outage from 5 s doubling to 60 s. `failures` counts outages in a row.
 */
export function afterPoll(history: { failures: number }, outcome: PollOutcome, now: number): { state: DeliveryState; waitMs: number; failures: number } {
  if (outcome.kind === 'answered') {
    const took = now - outcome.startedAt;
    const waitMs = outcome.messages === 0 && took < MIN_EMPTY_POLL_MS ? MIN_EMPTY_POLL_MS - took : 0;
    return { state: 'polling', waitMs, failures: 0 };
  }
  const { error } = outcome;
  const refused = (state: DeliveryState) => ({ state, waitMs: REFUSED_RETRY_MS, failures: 0 });
  if (error instanceof AttendanceAuthError) return refused('token_refused');
  if (error instanceof AttendanceRateLimitedError) return { state: 'rate_limited', waitMs: error.retryAfterSeconds * 1000, failures: 0 };
  if (error instanceof AttendanceRejectedError) {
    if (error.status === 403 && error.upstreamCode === 'insufficient_scope') return refused('missing_scope');
    if (error.status === 404) return refused('unsupported');
    if (error.status === 503 && error.upstreamCode === 'shutting_down') return { state: 'attendance_unreachable', waitMs: OUTAGE_FIRST_MS, failures: 0 };
    if (error.status < 500) return refused('rejected');
  }
  const failures = history.failures + 1;
  return { state: 'attendance_unreachable', waitMs: Math.min(OUTAGE_FIRST_MS * 2 ** (failures - 1), OUTAGE_MAX_MS), failures };
}

/** How long until another poll may start without passing attendance's limit; 0 when one may start now. */
export function pollBudgetWait(starts: readonly number[], now: number): number {
  const recent = starts.filter((t) => t > now - POLL_WINDOW_MS);
  if (recent.length < POLL_BUDGET) return 0;
  return recent[recent.length - POLL_BUDGET]! + POLL_WINDOW_MS - now;
}
