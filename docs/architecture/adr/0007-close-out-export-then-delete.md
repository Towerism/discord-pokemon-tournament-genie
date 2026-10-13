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

1. **Close** (an organizer or a day head judge, on the website or with the `#head-judges` button) runs
   a `lock` job. Members get their permissions from the guild base permissions first, so leaving Send
   out of an allow list doesn't remove it (ADR-0005). The lock therefore writes explicit **denies** for
   Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads and Add
   Reactions:
   - on the `@everyone` overwrite;
   - on the organizer-role overwrite;
   - on every member overwrite.

   View Channel and Read Message History stay allowed for each audience, and the bot's overwrite is
   unchanged. The lock also makes the day's penalties read-only for everyone but organizers (ADR-0006).
   It checkpoints per channel. The export doesn't start until every channel is locked.
2. An `export` job writes:
   - per-event penalty CSVs (ADR-0006) and a voided list;
   - per-channel transcripts and **per-thread transcripts** (every thread, active and archived, public
     and private, listed with Manage Threads), as JSON (complete: authors, timestamps, edits, embeds,
     attachment metadata) and as readable HTML;
   - for each transcript, a **high-water mark**: the newest message ID it holds;
   - attachments up to a size cap. Each URL is re-resolved through the API at download time, because
     Discord CDN URLs expire. An attachment over the cap, one that fails to download, or one whose message
     was deleted is recorded as `skipped` with its reason.

   Each file is recorded with its SHA-256 in `export_file`. A thread that can't be read fails the export.
3. The day stays `closed` with its channels locked for the **grace period** (`GENIE_PURGE_GRACE`,
   default 7 days). "Delete now" shortens it. The purge's due time is persisted and run by the jobs
   module's timer (ADR-0001), so a restart doesn't lose it.
4. The `purge` job deletes recorded channels and the category **only if all of these hold**:
   - the export job succeeded and every file's hash still matches;
   - no channel or thread has a message newer than its high-water mark. This catches an Administrator
     who still posts, for instance;
   - no attachment is `skipped`.

   Otherwise it refuses and alerts, and the organizer can choose **Re-export**, or **Retry attachments**
   after raising the cap, or confirm **Discard N attachments** (logged with who, when and the list).
   Deleting an already-gone channel counts as success.
5. **Alerts** for a refused purge or a failed close-out job go to a page-header banner for organizers
   and, while it still exists, the day's `#head-judges` channel.
6. **Serving.** Downloads are allowed by `canSee()` (ADR-0010): an event's CSVs and transcripts go to its
   head judges and organizers, and a day-wide channel's transcript to organizers and head judges in that
   channel's audience.
   - The HTML transcript escapes every message field and is served with `Content-Security-Policy:
     sandbox; default-src 'none'; style-src 'unsafe-inline'` and `X-Content-Type-Options: nosniff`.
   - JSON transcripts and attachments are always served with `Content-Disposition: attachment`, never
     inline, so staff-supplied content can't run script on Genie's origin.
7. A retention sweep later deletes transcripts and penalty data per the configured retention
   (90 days for transcripts, 1 year for penalty data, both configurable; architecture §15). Settings
   rejects a transcript retention that isn't longer than the grace period, and the sweep never touches
   a day that isn't `purged` yet.

## Consequences

- (+) Channels never outlive their day by more than the grace period, and never vanish before their
  content is safely on disk.
- (+) The head judge has the CSV the moment the day closes.
- (+) Nothing posted after the export, and no thread or attachment, can be deleted without either being
  exported or an organizer explicitly discarding it.
- (−) A purge can be held up by a late message or a skipped attachment until an organizer acts; the
  banner and the `#head-judges` post make that visible.
- (−) Transcripts need the MessageContent intent; without it they degrade to bot messages with a warning.
- (−) A busy day's transcript export takes a while (100 messages per call, rate-limited); it runs as a job
  with progress.
