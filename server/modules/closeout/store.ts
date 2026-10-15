import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { RefusalReason } from '../../../shared/closeout';
import type { Db } from '../../db/client';
import { dayCloseout, exportAttachment, exportFile, exportRun } from '../../db/schema';

export type RunRow = typeof exportRun.$inferSelect;
export type FileRow = typeof exportFile.$inferSelect;
export type AttachmentRow = typeof exportAttachment.$inferSelect;
export type CloseoutRow = typeof dayCloseout.$inferSelect;
export type NewFile = Omit<typeof exportFile.$inferInsert, 'id' | 'supersededBy'>;
export type FailureKind = 'lock' | 'export' | 'reexport' | 'attachments_retry' | 'purge' | 'correction';

const TRANSCRIPT_KINDS = ['transcript_json', 'transcript_html', 'thread_transcript_json', 'thread_transcript_html', 'attachment'] as const;
const CSV_KINDS = ['penalties_csv', 'penalties_voided_csv'] as const;

/** Two files are versions of each other when they hold the same thing (§6.5): kind, event, channel, thread, attachment. */
const sameIdentity = (a: FileRow, b: FileRow) =>
  a.kind === b.kind && a.eventId === b.eventId && a.channelId === b.channelId && a.threadId === b.threadId && a.attachmentId === b.attachmentId;

/** Close-out's own tables (§5.2). Nothing else reads or writes them. */
export function createCloseoutStore(db: Db) {
  const runOf = (id: number) => db.select().from(exportRun).where(eq(exportRun.id, id)).get()!;

  /** The day's current files: their run succeeded and nothing supersedes them. */
  function currentFiles(dayId: number): FileRow[] {
    return db
      .select({ file: exportFile })
      .from(exportFile)
      .innerJoin(exportRun, eq(exportRun.id, exportFile.runId))
      .where(and(eq(exportFile.dayId, dayId), isNull(exportFile.supersededBy), eq(exportRun.state, 'succeeded')))
      .orderBy(asc(exportFile.id))
      .all()
      .map((r) => r.file);
  }

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn);
    },

    // ---- runs
    startRun(run: { dayId: number; kind: RunRow['kind']; jobId: number | null; eventId?: number | null; now: number }): number {
      return db
        .insert(exportRun)
        .values({ dayId: run.dayId, kind: run.kind, jobId: run.jobId, eventId: run.eventId ?? null, state: 'running', startedAt: run.now })
        .returning({ id: exportRun.id })
        .get().id;
    },
    run: runOf,
    failRun(id: number, now: number): void {
      db.update(exportRun).set({ state: 'failed', finishedAt: now }).where(eq(exportRun.id, id)).run();
    },
    /**
     * A run's success: its rows become current, each superseding the current file of the same identity, except that a
     * CSV never supersedes one built from a newer penalty state; then it is superseded itself.
     */
    succeedRun(id: number, now: number, contentIntent: boolean | null): void {
      db.transaction(() => {
        const run = runOf(id);
        const current = currentFiles(run.dayId);
        const mine = db.select().from(exportFile).where(eq(exportFile.runId, id)).orderBy(asc(exportFile.id)).all();
        for (const file of mine) {
          const previous = current.find((c) => c.runId !== id && sameIdentity(c, file));
          if (!previous) continue;
          const csv = (CSV_KINDS as readonly string[]).includes(file.kind);
          if (csv && (previous.sourceRevision ?? 0) > (file.sourceRevision ?? 0)) {
            db.update(exportFile).set({ supersededBy: previous.id }).where(eq(exportFile.id, file.id)).run();
          } else {
            db.update(exportFile).set({ supersededBy: file.id }).where(eq(exportFile.id, previous.id)).run();
          }
        }
        db.update(exportRun).set({ state: 'succeeded', finishedAt: now, contentIntent }).where(eq(exportRun.id, id)).run();
      });
    },
    failedRuns(dayId: number): RunRow[] {
      return db.select().from(exportRun).where(and(eq(exportRun.dayId, dayId), eq(exportRun.state, 'failed'))).all();
    },
    /** A failed run's rows (its files are removed from disk first). */
    deleteRun(id: number): void {
      db.transaction(() => {
        const files = db.select({ id: exportFile.id }).from(exportFile).where(eq(exportFile.runId, id)).all().map((f) => f.id);
        if (files.length) db.update(exportAttachment).set({ fileId: null }).where(inArray(exportAttachment.fileId, files)).run();
        db.delete(exportRun).where(eq(exportRun.id, id)).run();
      });
    },
    /** At boot: a run left `running` was cut short by the process stopping. */
    failRunning(now: number): number {
      return db.update(exportRun).set({ state: 'failed', finishedAt: now }).where(eq(exportRun.state, 'running')).returning({ id: exportRun.id }).all().length;
    },
    hasSucceededExport(dayId: number): boolean {
      return (
        db
          .select({ id: exportRun.id })
          .from(exportRun)
          .where(and(eq(exportRun.dayId, dayId), eq(exportRun.state, 'succeeded'), inArray(exportRun.kind, ['export', 'reexport'])))
          .get() !== undefined
      );
    },

    // ---- files
    insertFile(file: NewFile): number {
      return db.insert(exportFile).values(file).returning({ id: exportFile.id }).get().id;
    },
    file(id: number): FileRow | null {
      return db.select().from(exportFile).where(eq(exportFile.id, id)).get() ?? null;
    },
    filesOfRun(runId: number): FileRow[] {
      return db.select().from(exportFile).where(eq(exportFile.runId, runId)).all();
    },
    currentFiles,
    /** Every file of the day that a succeeded run wrote, superseded ones too. */
    allFiles(dayId: number): FileRow[] {
      return db
        .select({ file: exportFile })
        .from(exportFile)
        .innerJoin(exportRun, eq(exportRun.id, exportFile.runId))
        .where(and(eq(exportFile.dayId, dayId), eq(exportRun.state, 'succeeded')))
        .orderBy(asc(exportFile.id))
        .all()
        .map((r) => r.file);
    },
    contentIntentOf(runId: number): boolean {
      return runOf(runId).contentIntent !== false;
    },
    /** Retention: every file of these kinds, every version (the sweep removes them from disk before their rows). */
    filesToSweep(dayId: number, which: 'transcripts' | 'csvs'): FileRow[] {
      const kinds = which === 'transcripts' ? TRANSCRIPT_KINDS : CSV_KINDS;
      return db
        .select()
        .from(exportFile)
        .where(and(eq(exportFile.dayId, dayId), inArray(exportFile.kind, [...kinds])))
        .all();
    },
    /** The rows of swept files. Their attachment rows go with the transcripts. */
    deleteFileRows(ids: readonly number[]): void {
      if (!ids.length) return;
      db.transaction(() => {
        db.update(exportFile).set({ supersededBy: null }).where(inArray(exportFile.id, [...ids])).run();
        db.delete(exportFile).where(inArray(exportFile.id, [...ids])).run();
      });
    },

    // ---- attachments
    insertAttachment(row: Omit<typeof exportAttachment.$inferInsert, 'id'>): number {
      return db.insert(exportAttachment).values(row).returning({ id: exportAttachment.id }).get().id;
    },
    attachmentsOf(fileIds: readonly number[]): AttachmentRow[] {
      if (!fileIds.length) return [];
      return db.select().from(exportAttachment).where(inArray(exportAttachment.exportFileId, [...fileIds])).orderBy(asc(exportAttachment.id)).all();
    },
    updateAttachment(id: number, patch: Partial<Pick<AttachmentRow, 'state' | 'reason' | 'fileId' | 'discardedBy' | 'discardedAt'>>): void {
      db.update(exportAttachment).set(patch).where(eq(exportAttachment.id, id)).run();
    },

    // ---- the day's close-out state
    /** A read that writes nothing: a day without a row reads as one with nothing recorded. */
    peek(dayId: number): CloseoutRow {
      return (
        db.select().from(dayCloseout).where(eq(dayCloseout.dayId, dayId)).get() ?? {
          dayId,
          purgeRefusal: null,
          purgeRefusedAt: null,
          lastFailure: null,
          failurePostedAt: null,
          alertMessageIds: '[]',
          transcriptsSweptAt: null,
          penaltiesSweptAt: null,
        }
      );
    },
    /** The day's row, created on the first write. */
    closeout(dayId: number): CloseoutRow {
      db.insert(dayCloseout).values({ dayId }).onConflictDoNothing().run();
      return db.select().from(dayCloseout).where(eq(dayCloseout.dayId, dayId)).get()!;
    },
    allCloseouts(): CloseoutRow[] {
      return db.select().from(dayCloseout).orderBy(asc(dayCloseout.dayId)).all();
    },
    setRefusal(dayId: number, reasons: RefusalReason[] | null, now: number): void {
      this.closeout(dayId);
      db.update(dayCloseout)
        .set({ purgeRefusal: reasons ? JSON.stringify(reasons) : null, purgeRefusedAt: reasons ? now : null })
        .where(eq(dayCloseout.dayId, dayId))
        .run();
    },
    setFailure(dayId: number, failure: { kind: FailureKind; error: string; at: number } | null): void {
      this.closeout(dayId);
      db.update(dayCloseout).set({ lastFailure: failure ? JSON.stringify(failure) : null }).where(eq(dayCloseout.dayId, dayId)).run();
    },
    addAlertMessage(dayId: number, messageId: string): void {
      const ids = JSON.parse(this.closeout(dayId).alertMessageIds) as string[];
      db.update(dayCloseout).set({ alertMessageIds: JSON.stringify([...ids, messageId]) }).where(eq(dayCloseout.dayId, dayId)).run();
    },
    setSwept(dayId: number, which: 'transcripts' | 'penalties', at: number): void {
      this.closeout(dayId);
      db.update(dayCloseout)
        .set(which === 'transcripts' ? { transcriptsSweptAt: at } : { penaltiesSweptAt: at })
        .where(eq(dayCloseout.dayId, dayId))
        .run();
    },
  };
}

export type CloseoutStore = ReturnType<typeof createCloseoutStore>;
