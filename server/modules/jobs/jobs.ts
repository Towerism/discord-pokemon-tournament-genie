import type { Clock, Logger, Redactor } from '@towerism/selfhost-kit';
import type { EventLevel, JobEventView, JobKind, JobStore, JobView } from './store';

export type { JobKind, JobView, JobEventView };

export interface JobContext {
  jobId: number;
  dayId: number | null;
  payload: unknown;
  /** Appends a job event; `data` goes through the redactor first. */
  log(level: EventLevel, message: string, data?: Record<string, unknown>): void;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export interface Jobs {
  register(kind: JobKind, handler: JobHandler, opts?: { retryOnBoot?: boolean }): void;
  enqueue(job: { kind: JobKind; dayId?: number; payload?: unknown; dueAt?: number }): number;
  /** A sync or provision for the day, unless one is already queued: then that one. Atomic. */
  enqueueUnlessQueued(job: { kind: 'provision' | 'sync'; dayId: number }): { jobId: number; coalesced: boolean };
  /**
   * At most one queued job of `kind` for the day (`dayId` null: install-wide): moves the queued one's due time, or
   * queues one. Timer work (the purge after grace, the retention sweep) uses it.
   */
  schedule(job: { kind: JobKind; dayId: number | null; dueAt: number }): number;
  /** The day's queued and running jobs, oldest first. */
  active(dayId: number): JobView[];
  /** The day's newest job of one of `kinds`, or `null`. */
  latestOf(dayId: number, kinds: readonly JobKind[]): JobView | null;
  /** Claims every due job the per-day lease allows and resolves when they have all finished. */
  runDue(): Promise<void>;
  /** At boot, before the first `runDue`: running jobs become interrupted; retry-on-boot kinds are queued again. */
  recover(): void;
  retry(jobId: number): void;
  get(jobId: number): JobView | null;
  /** The day's newest job, whatever its kind. */
  latestForDay(dayId: number): JobView | null;
  events(jobId: number): JobEventView[];
  /** Resolves once no job is running in this process and no automatic run is pending. */
  idle(): Promise<void>;
}

export class UnknownJobKindError extends Error {
  override name = 'UnknownJobKindError';
}
export class JobStateError extends Error {
  override name = 'JobStateError';
}

/**
 * Genie's jobs: a persisted queue with a lease per event day, an event log, boot recovery and retry
 * (architecture §3, §6.3, §10). Plain TS with its storage behind a port and an injected clock, so it can move
 * into the kit when a second app needs it.
 */
export function createJobs(opts: {
  store: JobStore;
  clock: Clock;
  logger: Logger;
  redactor: Redactor;
  /** Production: start work as soon as it is enqueued or a day's lease frees up. Tests call `runDue()`. */
  autoRun?: boolean;
}): Jobs {
  const { store, clock, logger, redactor, autoRun = false } = opts;
  const handlers = new Map<JobKind, { handler: JobHandler; retryOnBoot: boolean }>();
  const inflight = new Set<Promise<void>>();
  let kickPending = false;

  const event = (jobId: number, level: EventLevel, message: string, data?: unknown) =>
    store.appendEvent({ jobId, at: clock.now(), level, message, ...(data === undefined ? {} : { data: redactor.redact(data) }) });

  /** Keeps a run in `inflight` until it settles. A failure is logged here: nothing else awaits an automatic run. */
  const track = (promise: Promise<void>) => {
    const settled = promise
      .catch((err: unknown) => logger.error('A job run failed outside its handler.', { err }))
      .finally(() => inflight.delete(settled));
    inflight.add(settled);
  };

  const kick = () => {
    if (!autoRun || kickPending) return;
    kickPending = true;
    track(
      Promise.resolve().then(() => {
        kickPending = false;
        return runDue();
      }),
    );
  };

  async function run(job: JobView): Promise<void> {
    const registered = handlers.get(job.kind);
    try {
      if (!registered) throw new Error(`no handler for job kind ${job.kind}`);
      await registered.handler({
        jobId: job.id,
        dayId: job.dayId,
        payload: job.payload,
        log: (level, message, data) => event(job.id, level, message, data),
      });
      store.finish(job.id, { state: 'succeeded' }, clock.now());
      event(job.id, 'info', 'succeeded');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Job ${job.id} (${job.kind}) failed: ${message}`, { jobId: job.id, kind: job.kind, dayId: job.dayId, err });
      try {
        store.finish(job.id, { state: 'failed', error: message }, clock.now());
        event(job.id, 'error', `failed: ${message}`);
      } catch (storeErr) {
        // The job stays `running` until boot recovery interrupts it.
        logger.error(`Job ${job.id} could not be marked failed.`, { jobId: job.id, err: storeErr });
      }
    } finally {
      kick();
    }
  }

  function runDue(): Promise<void> {
    const now = clock.now();
    const claimed = store.transaction(() => {
      const leased = store.leasedDays();
      const taken: JobView[] = [];
      for (const job of store.listDue(now)) {
        if (job.dayId !== null && leased.has(job.dayId)) continue;
        if (!store.claim(job.id, now)) continue;
        if (job.dayId !== null) leased.add(job.dayId);
        event(job.id, 'info', 'claimed');
        taken.push(job);
      }
      return taken;
    });
    const runs = claimed.map((job) => run(job));
    for (const promise of runs) track(promise);
    return Promise.all(runs).then(() => undefined);
  }

  return {
    register(kind, handler, registerOpts = {}) {
      handlers.set(kind, { handler, retryOnBoot: registerOpts.retryOnBoot ?? false });
    },
    enqueue(job) {
      if (!handlers.has(job.kind)) throw new UnknownJobKindError(`No handler is registered for job kind ${job.kind}.`);
      const id = store.insert({
        kind: job.kind,
        dayId: job.dayId ?? null,
        payload: job.payload ?? null,
        dueAt: job.dueAt ?? null,
        createdAt: clock.now(),
      });
      kick();
      return id;
    },
    enqueueUnlessQueued(job) {
      if (!handlers.has(job.kind)) throw new UnknownJobKindError(`No handler is registered for job kind ${job.kind}.`);
      const result = store.transaction(() => {
        const queued = store.findQueued(['provision', 'sync'], job.dayId);
        if (queued !== null) return { jobId: queued, coalesced: true };
        const jobId = store.insert({ kind: job.kind, dayId: job.dayId, payload: null, dueAt: null, createdAt: clock.now() });
        return { jobId, coalesced: false };
      });
      if (!result.coalesced) kick();
      return result;
    },
    schedule(job) {
      if (!handlers.has(job.kind)) throw new UnknownJobKindError(`No handler is registered for job kind ${job.kind}.`);
      const id = store.transaction(() => {
        const queued = store.findQueuedOf(job.kind, job.dayId);
        if (queued !== null) {
          store.setDue(queued, job.dueAt);
          return queued;
        }
        return store.insert({ kind: job.kind, dayId: job.dayId, payload: null, dueAt: job.dueAt, createdAt: clock.now() });
      });
      kick();
      return id;
    },
    active: (dayId) => store.active(dayId),
    latestOf: (dayId, kinds) => store.latestOf(dayId, kinds),
    runDue,
    recover() {
      for (const job of store.listByState('running')) {
        store.transition(job.id, ['running'], 'interrupted');
        event(job.id, 'warn', 'interrupted: the process stopped while it ran');
        if (handlers.get(job.kind)?.retryOnBoot) {
          store.transition(job.id, ['interrupted'], 'queued');
          event(job.id, 'info', 'queued again after boot');
        }
      }
    },
    retry(jobId) {
      if (!store.transition(jobId, ['failed', 'interrupted'], 'queued')) {
        throw new JobStateError(`Job ${jobId} can only be retried when it failed or was interrupted.`);
      }
      event(jobId, 'info', 'queued again by retry');
      kick();
    },
    get: (jobId) => store.get(jobId),
    latestForDay: (dayId) => store.latestForDay(dayId),
    events: (jobId) => store.events(jobId),
    async idle() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
