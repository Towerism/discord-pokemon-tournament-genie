import { createRedactor, silentLogger } from '@towerism/selfhost-kit';
import { type FakeClock, fakeClock } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshDb } from '../../../test/support/db';
import type { OpenDatabase } from '../../db/client';
import { type Jobs, JobStateError, UnknownJobKindError, createJobs } from './jobs';
import { createSqliteJobStore } from './sqlite-store';
import { type Scheduler, startJobTimer } from './timer';

const MINUTE = 60_000;

/** A promise the test resolves: holds a handler mid-run without sleeping. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

let database: OpenDatabase;
let clock: FakeClock;
let jobs: Jobs;

const build = () =>
  createJobs({
    store: createSqliteJobStore(database.db),
    clock,
    logger: silentLogger,
    redactor: createRedactor({ extraKeys: ['botToken'] }),
  });

beforeEach(() => {
  database = freshDb();
  clock = fakeClock(1_000_000);
  jobs = build();
});
afterEach(() => database.close());

const messages = (id: number) => jobs.events(id).map((e) => e.message);

describe('enqueue and runDue', () => {
  it('runs a due job to success and logs claimed, the handler event and succeeded, in order', async () => {
    jobs.register('sync', async (ctx) => {
      ctx.log('info', 'synced 3 channels', { dayId: ctx.dayId });
    });
    const id = jobs.enqueue({ kind: 'sync', dayId: 7, payload: { reason: 'staff removed' } });
    expect(jobs.get(id)).toMatchObject({ state: 'queued', attempts: 0 });

    await jobs.runDue();

    expect(jobs.get(id)).toMatchObject({ state: 'succeeded', attempts: 1, error: null, startedAt: 1_000_000 });
    expect(messages(id)).toEqual(['claimed', 'synced 3 channels', 'succeeded']);
  });

  it('passes the payload and day to the handler', async () => {
    let seen: unknown;
    jobs.register('sync', async (ctx) => {
      seen = { dayId: ctx.dayId, payload: ctx.payload, jobId: ctx.jobId };
    });
    const id = jobs.enqueue({ kind: 'sync', dayId: 3, payload: { a: 1 } });
    await jobs.runDue();
    expect(seen).toEqual({ dayId: 3, payload: { a: 1 }, jobId: id });
  });

  it('refuses a kind with no registered handler', () => {
    expect(() => jobs.enqueue({ kind: 'purge', dayId: 1 })).toThrow(UnknownJobKindError);
  });

  it('marks a throwing job failed with its message, without stopping another day in the same run', async () => {
    jobs.register('sync', async (ctx) => {
      if (ctx.dayId === 7) throw new Error('boom');
    });
    const bad = jobs.enqueue({ kind: 'sync', dayId: 7 });
    const good = jobs.enqueue({ kind: 'sync', dayId: 8 });
    await jobs.runDue();
    expect(jobs.get(bad)).toMatchObject({ state: 'failed', error: 'boom' });
    expect(jobs.events(bad).at(-1)).toMatchObject({ level: 'error', message: 'failed: boom' });
    expect(jobs.get(good)).toMatchObject({ state: 'succeeded' });
  });

  it('redacts secrets in event data and keeps ordinary fields', async () => {
    jobs.register('sync', async (ctx) => {
      ctx.log('info', 'connected', { botToken: 'fake-bot-token-1', dayId: 7 });
    });
    const id = jobs.enqueue({ kind: 'sync', dayId: 7 });
    await jobs.runDue();
    expect(jobs.events(id)[1]?.data).toEqual({ botToken: '[REDACTED]', dayId: 7 });
  });
});

describe('the per-day lease', () => {
  it('runs at most one job per day at a time, while other days run alongside', async () => {
    const held = gate();
    const runningPerDay = new Map<number, number>();
    let maxDay7 = 0;
    jobs.register('sync', async (ctx) => {
      const day = ctx.dayId!;
      runningPerDay.set(day, (runningPerDay.get(day) ?? 0) + 1);
      if (day === 7) maxDay7 = Math.max(maxDay7, runningPerDay.get(day)!);
      await held.opened;
      runningPerDay.set(day, runningPerDay.get(day)! - 1);
    });
    const first7 = jobs.enqueue({ kind: 'sync', dayId: 7 });
    const second7 = jobs.enqueue({ kind: 'sync', dayId: 7 });
    const day8 = jobs.enqueue({ kind: 'sync', dayId: 8 });

    const run = jobs.runDue();
    expect(jobs.get(first7)?.state).toBe('running');
    expect(jobs.get(day8)?.state).toBe('running');
    expect(jobs.get(second7)?.state).toBe('queued');

    // A concurrent run (the timer firing mid-run) must not claim day 7 again.
    const overlapping = jobs.runDue();
    expect(jobs.get(second7)?.state).toBe('queued');

    held.open();
    await Promise.all([run, overlapping]);
    await jobs.runDue();

    expect(jobs.get(second7)?.state).toBe('succeeded');
    expect(maxDay7).toBe(1);
  });

  it('does not lease jobs without a day', async () => {
    const held = gate();
    jobs.register('retention_sweep', async () => held.opened);
    const a = jobs.enqueue({ kind: 'retention_sweep' });
    const b = jobs.enqueue({ kind: 'retention_sweep' });
    const run = jobs.runDue();
    expect([jobs.get(a)?.state, jobs.get(b)?.state]).toEqual(['running', 'running']);
    held.open();
    await run;
  });
});

describe('due times and the timer', () => {
  it('leaves a job queued until its due time, then runs it exactly once', async () => {
    const scheduler = fakeScheduler();
    let runs = 0;
    jobs.register('purge', async () => {
      runs += 1;
    });
    const id = jobs.enqueue({ kind: 'purge', dayId: 1, dueAt: clock.now() + 5 * MINUTE });
    const stop = startJobTimer({ jobs, scheduler, logger: silentLogger });
    await scheduler.settled();
    expect(scheduler.intervals).toEqual([MINUTE]);

    clock.advance(4 * MINUTE);
    await scheduler.tick();
    expect(jobs.get(id)?.state).toBe('queued');

    clock.advance(MINUTE);
    await scheduler.tick();
    await scheduler.tick();
    expect(jobs.get(id)?.state).toBe('succeeded');
    expect(runs).toBe(1);
    await stop();
    expect(scheduler.active()).toBe(false);
  });

  it('runs work that fell due while no process ran, once, when the timer starts', async () => {
    let runs = 0;
    const handler = async () => {
      runs += 1;
    };
    jobs.register('purge', handler);
    const id = jobs.enqueue({ kind: 'purge', dayId: 1, dueAt: clock.now() + MINUTE });

    // A new process, an hour later.
    clock.advance(60 * MINUTE);
    jobs = build();
    jobs.register('purge', handler);
    jobs.recover();
    const scheduler = fakeScheduler();
    const stop = startJobTimer({ jobs, scheduler, logger: silentLogger });
    await scheduler.settled();
    await scheduler.tick();

    expect(jobs.get(id)?.state).toBe('succeeded');
    expect(runs).toBe(1);
    await stop();
  });

  it('waits for running handlers when stopped', async () => {
    const held = gate();
    let finished = false;
    jobs.register('sync', async () => {
      await held.opened;
      finished = true;
    });
    jobs.enqueue({ kind: 'sync', dayId: 1 });
    const scheduler = fakeScheduler();
    const stop = startJobTimer({ jobs, scheduler, logger: silentLogger });
    const stopped = stop();
    held.open();
    await stopped;
    expect(finished).toBe(true);
  });
});

describe('boot recovery and retry', () => {
  it('interrupts jobs a previous process left running, and queues again the kinds that retry on boot', async () => {
    const held = gate();
    jobs.register('sync', async () => held.opened, { retryOnBoot: true });
    jobs.register('lock', async () => held.opened);
    const sync = jobs.enqueue({ kind: 'sync', dayId: 1 });
    const lock = jobs.enqueue({ kind: 'lock', dayId: 2 });
    void jobs.runDue();
    expect([jobs.get(sync)?.state, jobs.get(lock)?.state]).toEqual(['running', 'running']);

    // The process dies here; a new one boots on the same database.
    jobs = build();
    jobs.register('sync', async () => {}, { retryOnBoot: true });
    jobs.register('lock', async () => {});
    jobs.recover();

    expect(jobs.get(sync)?.state).toBe('queued');
    expect(messages(sync)).toContain('interrupted: the process stopped while it ran');
    expect(messages(sync).at(-1)).toBe('queued again after boot');
    expect(jobs.get(lock)?.state).toBe('interrupted');

    jobs.retry(lock);
    expect(jobs.get(lock)?.state).toBe('queued');
    await jobs.runDue();
    expect(jobs.get(lock)).toMatchObject({ state: 'succeeded', attempts: 2 });
    held.open();
  });

  it('retries a failed job and refuses to retry any other state', async () => {
    let fail = true;
    jobs.register('export', async () => {
      if (fail) throw new Error('disk full');
    });
    const id = jobs.enqueue({ kind: 'export', dayId: 1 });
    await jobs.runDue();
    expect(jobs.get(id)?.state).toBe('failed');

    fail = false;
    jobs.retry(id);
    await jobs.runDue();
    expect(jobs.get(id)).toMatchObject({ state: 'succeeded', attempts: 2, error: null });
    expect(() => jobs.retry(id)).toThrow(JobStateError);
    expect(() => jobs.retry(999)).toThrow(JobStateError);
  });

  it('fails a job whose kind lost its handler, rather than leaving it running', async () => {
    jobs.register('sync', async () => {});
    const id = jobs.enqueue({ kind: 'sync', dayId: 1 });
    jobs = build();
    await jobs.runDue();
    expect(jobs.get(id)).toMatchObject({ state: 'failed', error: 'no handler for job kind sync' });
  });
});

describe('auto run', () => {
  it('starts enqueued work on its own, and picks up lease-blocked work when the day frees up', async () => {
    const auto = createJobs({
      store: createSqliteJobStore(database.db),
      clock,
      logger: silentLogger,
      redactor: createRedactor(),
      autoRun: true,
    });
    const order: number[] = [];
    auto.register('sync', async (ctx) => {
      order.push(ctx.jobId);
    });
    const a = auto.enqueue({ kind: 'sync', dayId: 1 });
    const b = auto.enqueue({ kind: 'sync', dayId: 1 });
    await auto.idle();
    expect(order).toEqual([a, b]);
    expect(auto.get(b)?.state).toBe('succeeded');
  });
});

/** Records the interval and fires it by hand. */
function fakeScheduler(): Scheduler & {
  intervals: number[];
  tick(): Promise<void>;
  settled(): Promise<void>;
  active(): boolean;
} {
  let fn: (() => Promise<void>) | undefined;
  const intervals: number[] = [];
  let pending: Promise<void> = Promise.resolve();
  return {
    intervals,
    every(ms, callback) {
      intervals.push(ms);
      fn = callback;
      return () => {
        fn = undefined;
      };
    },
    now(callback) {
      pending = callback();
    },
    async tick() {
      await fn?.();
    },
    settled: () => pending,
    active: () => fn !== undefined,
  };
}
