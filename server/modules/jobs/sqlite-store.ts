import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { job, jobEvent } from '../../db/schema';
import type { JobEventView, JobStore, JobView } from './store';

type JobRow = typeof job.$inferSelect;

const parse = (text: string | null): unknown => (text === null ? null : JSON.parse(text));
const serialize = (value: unknown): string | null => (value === undefined || value === null ? null : JSON.stringify(value));
const view = (row: JobRow): JobView => ({ ...row, payload: parse(row.payload) });

/** The jobs store on Genie's SQLite database (better-sqlite3 is synchronous, so each call is atomic). */
export function createSqliteJobStore(db: Db): JobStore {
  return {
    insert(j) {
      const row = db
        .insert(job)
        .values({ kind: j.kind, state: 'queued', dayId: j.dayId, payload: serialize(j.payload), dueAt: j.dueAt, createdAt: j.createdAt })
        .returning({ id: job.id })
        .get();
      return row.id;
    },
    get(id) {
      const row = db.select().from(job).where(eq(job.id, id)).get();
      return row ? view(row) : null;
    },
    listDue(now) {
      return db
        .select()
        .from(job)
        .where(and(eq(job.state, 'queued'), or(isNull(job.dueAt), lte(job.dueAt, now))))
        .orderBy(asc(job.id))
        .all()
        .map(view);
    },
    listByState(state) {
      return db.select().from(job).where(eq(job.state, state)).orderBy(asc(job.id)).all().map(view);
    },
    findQueued(kinds, dayId) {
      const row = db
        .select({ id: job.id })
        .from(job)
        .where(and(eq(job.state, 'queued'), eq(job.dayId, dayId), inArray(job.kind, [...kinds])))
        .orderBy(asc(job.id))
        .get();
      return row?.id ?? null;
    },
    leasedDays() {
      const rows = db
        .selectDistinct({ dayId: job.dayId })
        .from(job)
        .where(and(eq(job.state, 'running'), isNotNull(job.dayId)))
        .all();
      return new Set(rows.map((r) => r.dayId as number));
    },
    claim(id, now) {
      const rows = db
        .update(job)
        .set({ state: 'running', startedAt: now, finishedAt: null, error: null, attempts: sql`${job.attempts} + 1` })
        .where(and(eq(job.id, id), eq(job.state, 'queued')))
        .returning({ id: job.id })
        .all();
      return rows.length === 1;
    },
    finish(id, outcome, now) {
      db.update(job)
        .set({ state: outcome.state, finishedAt: now, error: outcome.state === 'failed' ? outcome.error : null })
        .where(eq(job.id, id))
        .run();
    },
    transition(id, from, to) {
      const rows = db
        .update(job)
        .set({ state: to })
        .where(and(eq(job.id, id), inArray(job.state, [...from])))
        .returning({ id: job.id })
        .all();
      return rows.length === 1;
    },
    appendEvent(e) {
      db.insert(jobEvent)
        .values({ jobId: e.jobId, at: e.at, level: e.level, message: e.message, data: serialize(e.data) })
        .run();
    },
    events(jobId) {
      return db
        .select()
        .from(jobEvent)
        .where(eq(jobEvent.jobId, jobId))
        .orderBy(asc(jobEvent.id))
        .all()
        .map((row): JobEventView => ({ ...row, data: parse(row.data) }));
    },
    transaction(fn) {
      return db.transaction(() => fn());
    },
  };
}
