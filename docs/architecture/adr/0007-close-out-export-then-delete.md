# ADR-0007: Close-out: lock, export, then delete after a grace period

- Status: Proposed
- Date: 2026-10-13

## Context

Once a day is over its channels are no longer wanted and must not be reused. But they hold the
penalties the head judge still has to submit, and conversations someone may need to look back on (an
appeal, a question from the organizer). Deleting a Discord channel cannot be undone.

## Options considered

1. **Lock → export (CSV + transcripts) → delete after a grace period, deletion gated on the export.**
2. **Export and delete immediately.** Tidy, but leaves no window to look something up in Discord.
3. **Lock and keep forever in an archive category.** No data loss, but channels pile up (500 per guild),
   and it amounts to the reuse the owner doesn't want.

## Decision

Option 1.

1. **Close** (organizer or a head judge of the day, website or `#head-judges` button) runs a `lock`
   job. It rewrites every channel's overwrites to View + Read History, removing Send, and makes the
   day's penalties read-only.
2. An `export` job writes:
   - per-event penalty CSVs (ADR-0006) and a voided list;
   - per-channel transcripts, as JSON (complete: authors, timestamps, edits, embeds, attachment metadata)
     and as readable HTML;
   - attachments downloaded up to a size cap.

   Each file is recorded with its SHA-256 in `export_file`.
3. The day stays `closed` with its channels locked for the **grace period** (`GENIE_PURGE_GRACE`,
   default 7 days). "Delete now" shortens it.
4. The scheduled `closeout:purge` task deletes recorded channels and the category. It does so **only if
   the export job succeeded and every file's hash still matches**; otherwise it refuses and alerts.
   Deleting an already-gone channel counts as success.
5. A retention sweep later deletes transcripts and penalty data per the configured retention
   (90 days for transcripts, 1 year for penalty data, both configurable; architecture §15).

## Consequences

- (+) Channels never outlive their day by more than the grace period, and never vanish before their
  content is safely on disk.
- (+) The head judge has the CSV the moment the day closes.
- (−) Transcripts need the MessageContent intent; without it they degrade to bot messages with a warning.
- (−) A busy day's transcript export takes a while (100 messages per call, rate-limited); it runs as a job
  with progress.
