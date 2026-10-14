# S4: transcript export

Can the close-out export ([architecture §6.5](../architecture/README.md#65-close-the-day),
[ADR-0007](../architecture/adr/0007-close-out-export-then-delete.md)) read a busy day completely enough
for the purge gate, through the `DiscordGateway` contract in §4.1?

- **Recorded:** 2026-10-14, discord.js 14.27.0, API v10, guild `genie-spike-<name>` (throwaway).
- **Seed:** run `20261014073319-9a00` (kept for the expiry check). A category with 4 channels and 2,000
  messages spread across them by `arranger`, `probe-a` and `probe-b`; 6 threads in one channel with at
  least 20 messages each; 25 attachments. Seeding took 810,740 ms (13.5 minutes, under the 15-minute target).
- **Measured:** `pnpm spike s4 measure` once, then `measure --content-probe` with Message Content on, off,
  and on again (toggled in the developer portal).

## Answers to the §13 questions

### History paging speed

`genie` paged every seeded channel and thread 100 messages at a time, oldest-last.

| Target | Messages | Pages | Median per page | p95 per page | Total |
| ------ | -------- | ----- | --------------- | ------------ | ----- |
| channel 1 (thread parent) | 520 | 6 | 277 ms | 439 ms | 1,944 ms |
| channel 2 | 506 | 6 | 310 ms | 451 ms | 1,930 ms |
| channel 3 | 506 | 6 | 210 ms | 426 ms | 1,639 ms |
| channel 4 | 506 | 6 | 308 ms | 473 ms | 2,027 ms |
| public thread (active) | 20 | 1 | 190 ms | 190 ms | 190 ms |
| public thread (active) | 20 | 1 | 464 ms | 464 ms | 464 ms |
| public thread (archived) | 20 | 1 | 815 ms | 815 ms | 815 ms |
| private thread (active, `genie` added) | 23 | 1 | 409 ms | 409 ms | 409 ms |
| private thread (active, `genie` not added) | 22 | 1 | 187 ms | 187 ms | 187 ms |
| private thread (archived, `genie` added) | 23 | 1 | 227 ms | 227 ms | 227 ms |
| **All** | **2,166** | **30** | | | **9,832 ms** |

Channel counts include the attachment messages and the threads' starter messages. Paging averaged about
330 ms per page, with no 429s at this volume.

### Attachment sizes

All 25 uploads succeeded, including 10,485,761 bytes (10 MiB + 1 byte), so this guild's upload cap is above
10 MiB and the spike didn't reach a refusal. Genie's export cap is its own setting (§6.5) and is unaffected.

| Size (bytes) | Count | Downloaded |
| ------------ | ----- | ---------- |
| 1,024 | 1 | 200, 308 ms |
| 1,048,576 | 1 | 200, 657 ms |
| 3,145,728 (phone photos) | 20 | 200 each, median about 500 ms, slowest 3,543 ms |
| 8,388,608 | 1 | 200, 345 ms |
| 10,485,760 | 1 | 200, 643 ms |
| 10,485,761 | 1 | 200, 723 ms |

In all, 93,324,289 bytes downloaded in 20,390 ms, one at a time. Every download returned exactly the
uploaded size.

### Projected export time for the seeded busy day

About 30 seconds, one call at a time: about 10 s of history paging (30 pages), about 20 s of attachment
downloads (93 MB), and a handful of thread-listing and message re-fetch calls. A larger day scales at
about 0.33 s per 100 messages plus the attachment bytes; for example, 9 channels and 20 threads with the
same 2,000 messages would take about 49 pages, roughly 16 s of paging. The export is not the bottleneck of
close-out.

### Thread listing

`genie` listed threads with its candidate role (Manage Threads included), then with Manage Threads removed
from its role by `arranger` (snapshotted and restored).

| Seeded thread | With Manage Threads | Without Manage Threads |
| ------------- | ------------------- | ---------------------- |
| public, active (×2) | found (active) | found (active) |
| public, archived | found (archived public) | found (archived public) |
| private, active, `genie` added | found (active) | found (active) |
| private, active, `genie` **not** added | found (active) | **missed, with no error** |
| private, archived, `genie` added | found (archived private) | found only via joined archived private |

Without Manage Threads, the archived-private listing fails with 403 (code 50001), and the active listing
silently omits private threads `genie` isn't a member of.

**Does §4.1's `listThreads` contract hold?** Yes, with Manage Threads, which §4.1's invite set includes:
every seeded thread kind was found. Without it, one thread kind disappears **without an error**, which the
next answer turns on. One kind wasn't seeded or tested: an **archived** private thread `genie` is **not**
a member of. That gap, and the expired-URL check below, are a follow-up before M5.

### Attachment URL expiry and re-resolution

Every CDN URL carried an `ex` expiry about 24 hours after upload (2026-10-15 07:46 UTC for this seed).
Re-fetching the message the same day returned the same expiry; re-resolution doesn't extend a URL that
hasn't expired yet.

**After expiry: not yet run.** The check was due after the latest recorded expiry (2026-10-15 07:46:43 UTC),
but the local seed record holding the old URLs was lost before then, so it can't run against this seed.
Running it needs a new seed and a check a day later. `pnpm spike s4 check-expired` tries each old URL and a
freshly re-resolved one, and this section will record both statuses.

### MessageContent

Probed over REST only (no gateway login), 10 seeded messages each time:

| Message kind | Count | Intent **on**: fields present | Intent **off**: fields present |
| ------------ | ----- | ----------------------------- | ------------------------------ |
| plain text | 4 | content | none |
| with attachments | 3 | content, attachments | none |
| with an embed | 2 | embeds | none |
| mentioning `genie` | 1 | content | content |

All 10 matched Discord's documented behaviour both times: without the intent, content, attachments,
embeds and components come back empty, except in messages that mention the app. A transcript exported
without the intent would be nearly blank, so §4.1's wizard check for the intent is essential.

## Do §6.5's purge preconditions hold as written?

Mostly. The high-water check (`getLatestMessageId`), hash checks and attachment re-resolution all rely on
calls that behaved as documented. One gap: §6.5 blocks the purge when a thread "can't be read", but a
private thread that `listThreads` never returns isn't "unreadable"; it is invisible. If an administrator
removed Manage Threads from Genie's role, the export would skip private threads Genie isn't in without
any error, and the purge could delete them unexported.

**Amendment** (architecture §6.5, step 3, accepted by the owner on 2026-10-14): before listing threads, the export checks that Genie
holds Manage Threads and Read Message History in each channel, and fails (blocking the purge) if it
doesn't. No ADR change is needed; ADR-0007 already says the purge is blocked unless the export is
complete.

## Summary of contradictions

| Finding | Contradicts | Amendment |
| ------- | ----------- | --------- |
| Without Manage Threads, private threads Genie isn't in are omitted silently | §6.5's "if a thread can't be read, the export fails" doesn't cover it | §6.5 step 3 now checks Manage Threads and Read Message History before listing |

Everything else matched the architecture as written.
