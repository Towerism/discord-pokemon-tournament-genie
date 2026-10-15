import type { JOB_KINDS, JOB_STATES } from '../../db/schema';

export type JobKind = (typeof JOB_KINDS)[number];
export type JobState = (typeof JOB_STATES)[number];
export type EventLevel = 'info' | 'warn' | 'error';

export interface JobView {
  id: number;
  kind: JobKind;
  state: JobState;
  dayId: number | null;
  payload: unknown;
  dueAt: number | null;
  attempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobEventView {
  id: number;
  jobId: number;
  at: number;
  level: EventLevel;
  message: string;
  data: unknown;
}

/**
 * Where jobs live. The jobs module is the only caller (architecture §3), so it can move into the kit with a
 * different store behind this port (selfhost-kit ADR-0002).
 */
export interface JobStore {
  insert(job: { kind: JobKind; dayId: number | null; payload: unknown; dueAt: number | null; createdAt: number }): number;
  get(id: number): JobView | null;
  latestForDay(dayId: number): JobView | null;
  /** Queued jobs due at `now` (or with no due time), oldest first. */
  listDue(now: number): JobView[];
  listByState(state: JobState): JobView[];
  /** The oldest queued job of one of `kinds` for the day, or `null`. */
  findQueued(kinds: readonly JobKind[], dayId: number): number | null;
  /** Days that have a running job: the per-day lease. */
  leasedDays(): Set<number>;
  /** `queued` → `running`, counting the attempt. False when the job wasn't queued any more. */
  claim(id: number, now: number): boolean;
  finish(id: number, outcome: { state: 'succeeded' } | { state: 'failed'; error: string }, now: number): void;
  /** Moves a job from one of `from` to `to`. False when it wasn't in one of them. */
  transition(id: number, from: readonly JobState[], to: JobState): boolean;
  appendEvent(event: { jobId: number; at: number; level: EventLevel; message: string; data?: unknown }): void;
  events(jobId: number): JobEventView[];
  /** Runs `fn` atomically. */
  transaction<T>(fn: () => T): T;
}
