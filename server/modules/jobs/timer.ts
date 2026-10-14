import type { Logger } from '@towerism/selfhost-kit';
import type { Jobs } from './jobs';

/** Time-based scheduling, injected so tests fire it by hand. */
export interface Scheduler {
  /** Calls `fn` every `ms`; returns a function that stops it. */
  every(ms: number, fn: () => Promise<void>): () => void;
  /** Calls `fn` once, as soon as possible. */
  now(fn: () => Promise<void>): void;
}

export const DUE_CHECK_INTERVAL_MS = 60_000;

export const systemScheduler: Scheduler = {
  every(ms, fn) {
    const handle = setInterval(() => void fn(), ms);
    handle.unref();
    return () => clearInterval(handle);
  },
  now(fn) {
    setImmediate(() => void fn());
  },
};

/**
 * Runs due work every 60 s, and once straight away so whatever fell due while the container was down runs at
 * boot (§10). Call `jobs.recover()` first. Returns `stop`, which waits for running handlers.
 */
export function startJobTimer(opts: { jobs: Jobs; scheduler: Scheduler; logger: Logger; intervalMs?: number }): () => Promise<void> {
  const { jobs, scheduler, logger, intervalMs = DUE_CHECK_INTERVAL_MS } = opts;
  const tick = () =>
    jobs.runDue().catch((err: unknown) => {
      logger.error('The job timer could not run due jobs.', { err });
    });
  const cancel = scheduler.every(intervalMs, tick);
  scheduler.now(tick);
  return async () => {
    cancel();
    await jobs.idle();
  };
}
