/**
 * Delivers attendance's Discord messages (issue #51, ADR-0017, attendance ADR-0015 §7). One loop keeps a long poll open
 * on attendance while setup is done, a connection is saved and the bot is connected; it sends each message as a DM to
 * the linked staff member and reports what happened. Message text, links and player IDs are never logged or stored.
 */
import { createHash } from 'node:crypto';
import type { Clock, Logger } from '@towerism/selfhost-kit';
import type { Db } from '../../db/client';
import { type AttendanceMessages, AttendanceRejectedError, AttendanceUnavailableError, type MessageResult, type PolledMessage } from '../attendance/port';
import { type DirectoryService, PLAYER_ID } from '../directory';
import type { DiscordGateway } from '../discord/port';
import { type DeliveryState, POLL_WINDOW_MS, REFUSED_RETRY_MS, afterPoll, decide, pollBudgetWait, toResult } from './rules';
import { createDeliveryStore } from './store';

export type { DeliveryState } from './rules';

/** One-shot timers, injected so tests fire them by hand. */
export interface DelayScheduler {
  after(ms: number, fn: () => void): () => void;
}

export const systemDelayScheduler: DelayScheduler = {
  after(ms, fn) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return () => clearTimeout(handle);
  },
};

export interface DeliveryStatus {
  state: DeliveryState;
  /** Epoch ms the state began. */
  since: number | null;
  /** Epoch ms the last poll was answered. */
  lastPollAt: number | null;
  /** Epoch ms attendance last accepted a result. */
  lastResultAt: number | null;
}

/** Which attendance handed a message out: message IDs are only unique within one attendance. */
export const connectionKey = (baseUrl: string): string => createHash('sha256').update(baseUrl).digest('hex');

const POLL_WAIT_SECONDS = 25;
const POLL_LIMIT = 20;
/** No send starts this long after a poll answered, so a slow Discord can't lapse attendance's 2-minute presence. */
const BATCH_SEND_WINDOW_MS = 60_000;
const REPORT_RETRY_MS = [1000, 2000, 4000];
const RETENTION_MS = 30 * 86_400_000;
const SWEEP_EVERY_MS = 86_400_000;
const PROBLEM_STATES: ReadonlySet<DeliveryState> = new Set(['token_refused', 'missing_scope', 'unsupported', 'rejected', 'token_unreadable', 'rate_limited', 'attendance_unreachable']);

/** Why a batch stops: on `bot`, the message in hand is still recorded and reported; on the others, nothing more is. */
type StopReason = 'stop' | 'connection' | 'bot';

export function createMessageDeliveryService(opts: {
  db: Db;
  clock: Clock;
  logger: Logger;
  scheduler: DelayScheduler;
  directory: Pick<DirectoryService, 'byPlayerIds'>;
  /** Setup is complete. */
  ready: () => boolean;
  /** The saved attendance connection, or `null`. Throws when the token can't be unsealed. */
  connection: () => { baseUrl: string; token: string } | null;
  messages: (connection: { baseUrl: string; token: string }) => AttendanceMessages;
  gateway: () => DiscordGateway;
  bot: { isConnected(): boolean; onStateChange(listener: (state: string) => void): () => void };
}) {
  const { clock, logger, scheduler, directory, bot } = opts;
  const store = createDeliveryStore(opts.db);
  let stopped = true;
  let running: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  /** The poll and messages in hand: `poll` aborts on any stop, `discard` only when their results must be thrown away. */
  let batch: { poll: AbortController; discard: AbortController } | null = null;
  let wakeIdle: (() => void) | null = null;
  let state: DeliveryState = 'off';
  let since: number | null = null;
  let lastPollAt: number | null = null;
  let lastResultAt: number | null = null;
  let failures = 0;
  let starts: number[] = [];
  let lastSweep: number | null = null;
  /** Bumped by each stop, so a loop a stop left behind can't keep running beside a new one. */
  let generation = 0;
  /** DM sends in flight. Discord can't be interrupted, so a stop doesn't wait for them; their results are dropped. */
  let sending = 0;

  function setState(next: DeliveryState): void {
    if (next === state) return;
    state = next;
    since = clock.now();
    if (PROBLEM_STATES.has(next)) logger.warn('Discord message delivery is held up.', { state: next });
    else logger.info('Discord message delivery state changed.', { state: next });
  }

  /** Resolves after `ms` on the scheduler, when `signal` aborts, or, for the loop's idle wait, when woken. */
  function sleep(ms: number, signal: AbortSignal | null, idle: boolean): Promise<void> {
    return new Promise((resolve) => {
      let cancel = () => {};
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancel();
        signal?.removeEventListener('abort', finish);
        if (wakeIdle === finish) wakeIdle = null;
        resolve();
      };
      if (signal?.aborted || ms <= 0) return void queueMicrotask(finish);
      cancel = scheduler.after(ms, finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (idle) wakeIdle = finish;
    });
  }

  function stopBatch(reason: StopReason): void {
    if (!batch) return;
    if (reason !== 'bot') batch.discard.abort(reason);
    batch.poll.abort(reason);
  }

  /** Runs until stopped. A loop a stop left behind (still waiting on Discord) ends as soon as it wakes. */
  async function loop(gen: number): Promise<void> {
    const live = () => !stopped && gen === generation;
    while (live()) {
      let waitMs: number;
      try {
        waitMs = await cycle();
      } catch (err) {
        // Nothing here should throw; if something does, the loop backs off as for an outage and carries on.
        logger.warn('Discord message delivery failed unexpectedly.', { error: err instanceof Error ? err.name : 'unknown' });
        const next = afterPoll({ failures }, { kind: 'failed', error: err }, clock.now());
        failures = next.failures;
        setState(next.state);
        waitMs = next.waitMs;
      }
      if (live()) await sleep(waitMs, null, true);
    }
  }

  /** One poll and its messages; answers how long to wait before the next. */
  async function cycle(): Promise<number> {
    sweepIfDue();
    if (!opts.ready()) return idle('off');
    let connection: { baseUrl: string; token: string } | null;
    try {
      connection = opts.connection();
    } catch {
      return idle('token_unreadable');
    }
    if (!connection) return idle('off');
    if (!bot.isConnected()) return idle('waiting_for_bot');
    const budget = pollBudgetWait(starts, clock.now());
    if (budget > 0) return budget;
    if (state === 'off' || state === 'waiting_for_bot' || state === 'token_unreadable') setState('polling');

    const current = { poll: new AbortController(), discard: new AbortController() };
    batch = current;
    try {
      return await pollAndDeliver(connection, current);
    } finally {
      // A loop a stop left behind must not clear the batch of the loop that replaced it.
      if (batch === current) batch = null;
    }
  }

  /** One poll and the messages it hands out, bound to the connection that polled. */
  async function pollAndDeliver(connection: { baseUrl: string; token: string }, current: NonNullable<typeof batch>): Promise<number> {
    const key = connectionKey(connection.baseUrl);
    const channel = opts.messages(connection);
    const startedAt = clock.now();
    starts = [...starts.filter((t) => t > startedAt - POLL_WINDOW_MS), startedAt];
    let polled: PolledMessage[];
    try {
      polled = await channel.poll({ waitSeconds: POLL_WAIT_SECONDS, limit: POLL_LIMIT, signal: current.poll.signal });
    } catch (error) {
      if (current.poll.signal.aborted) return 0;
      const next = afterPoll({ failures }, { kind: 'failed', error }, clock.now());
      failures = next.failures;
      setState(next.state);
      return next.waitMs;
    }
    if (current.poll.signal.aborted) return 0;
    const answeredAt = clock.now();
    lastPollAt = answeredAt;
    const next = afterPoll({ failures }, { kind: 'answered', startedAt, messages: polled.length }, answeredAt);
    failures = next.failures;
    setState(next.state);
    for (const message of polled) {
      if (current.poll.signal.aborted || clock.now() - answeredAt >= BATCH_SEND_WINDOW_MS) break;
      await handle(message, key, channel, current);
    }
    return current.poll.signal.aborted ? 0 : next.waitMs;
  }

  function idle(next: DeliveryState): number {
    setState(next);
    return REFUSED_RETRY_MS;
  }

  function sweepIfDue(): void {
    const now = clock.now();
    if (lastSweep !== null && now - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = now;
    const swept = store.sweep(now - RETENTION_MS);
    if (swept) logger.info('Old delivery records deleted.', { count: swept });
  }

  async function handle(message: PolledMessage, key: string, channel: AttendanceMessages, current: NonNullable<typeof batch>): Promise<void> {
    const recorded = store.outcome(key, message.id);
    let result: MessageResult;
    if (recorded) {
      result = { status: recorded };
    } else {
      const recipient = message.kind === 'message' && PLAYER_ID.test(message.playerId) ? (directory.byPlayerIds([message.playerId])[0] ?? null) : null;
      const decision = decide(message, recipient, clock.now());
      if ('send' in decision) {
        let outcome: Parameters<typeof toResult>[0];
        sending += 1;
        try {
          outcome = await opts.gateway().sendDirectMessage(decision.send.userId, decision.send.content);
        } catch (error) {
          outcome = { error };
        } finally {
          sending -= 1;
        }
        result = toResult(outcome);
      } else {
        result = decision.report;
      }
      if (current.discard.signal.aborted) return;
      if (result.status !== 'failed') store.record(key, message.id, result.status, clock.now());
    }
    logger.info('Attendance message handled.', { messageId: message.id, status: result.status, ...(result.status === 'failed' ? { reason: result.reason } : {}) });
    await report(message.id, result, key, channel, current);
  }

  /** Posts a result, retrying an outage after 1, 2 and 4 s; anything else is left for attendance to hand out again. */
  async function report(id: number, result: MessageResult, key: string, channel: AttendanceMessages, current: NonNullable<typeof batch>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await channel.report(id, result, current.discard.signal);
        if (current.discard.signal.aborted) return;
        if (answer === 'not_found') logger.warn('Attendance no longer has the message.', { messageId: id });
        else lastResultAt = clock.now();
        if (result.status !== 'failed') store.markReported(key, id, clock.now());
        return;
      } catch (error) {
        if (current.discard.signal.aborted) return;
        const outage = error instanceof AttendanceUnavailableError || (error instanceof AttendanceRejectedError && error.status >= 500);
        const wait = REPORT_RETRY_MS[attempt];
        if (!outage || wait === undefined || current.poll.signal.aborted) {
          logger.warn('Attendance didn’t take the result; it will hand the message out again.', { messageId: id, error: error instanceof Error ? error.name : 'unknown' });
          return;
        }
        await sleep(wait, current.poll.signal, false);
        if (current.poll.signal.aborted) return;
      }
    }
  }

  return {
    /** Starts the loop; a no-op while it runs. */
    start(): void {
      if (!stopped) return;
      stopped = false;
      unsubscribe = bot.onStateChange((next) => {
        if (next === 'connected') wakeIdle?.();
        else stopBatch('bot');
      });
      running = loop(generation);
    },

    /**
     * Aborts the poll and anything in hand. Resolves once the loop has ended, or at once while a DM send is in flight:
     * Discord can take 45 s to answer, and the bot's logout and the database's close wait behind this. Nothing is
     * written or reported after it.
     */
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      generation += 1;
      unsubscribe?.();
      unsubscribe = null;
      stopBatch('stop');
      wakeIdle?.();
      const ending = running;
      running = null;
      if (sending === 0) await ending;
    },

    status(): DeliveryStatus {
      return { state, since, lastPollAt, lastResultAt };
    },

    /**
     * Called after every save or removal of the attendance connection: the batch in hand is dropped, the next poll
     * uses the new connection at once, and a removed connection's records are forgotten.
     */
    connectionChanged(change: { before: { baseUrl: string } | null; after: { baseUrl: string } | null }): void {
      stopBatch('connection');
      if (change.before && !change.after) store.forget(connectionKey(change.before.baseUrl));
      // The old token's or address's problem no longer applies; the next poll, made at once, says whether a new one does.
      failures = 0;
      if (change.after && PROBLEM_STATES.has(state)) setState('polling');
      wakeIdle?.();
    },
  };
}

export type MessageDeliveryService = ReturnType<typeof createMessageDeliveryService>;
