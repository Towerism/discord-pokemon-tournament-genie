# ADR-0006: Penalties as structured records through `/penalty`, with the catalog as data

- Status: Proposed
- Date: 2026-10-13

## Context

Judges record penalties during the day; at the end the head judge submits a CSV per tournament. The
owner's sample fixes the format:

```
Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes
```

Today penalties are posted as free text and the head judge rebuilds the CSV by hand. The owner chose a
structured command over scraping free text.

Things the sample tells us:

- Rows carry **player IDs only, no names**.
- **Penalty** uses short labels (`DPC` for Double Prize Penalty).
- **Category** is a guideline category (`Gameplay Error`, `Deck Legality`).
- **Severity** is Minor or Major (the clipboard sheet adds Severe).
- **Round of Issue** keeps counting into top cut.

Judges already use the **clipboard penalty sheet** (2024-05):

- Infraction Type: Game Play, Deck/Team, Pace of Play, Procedural, Unsporting, Cheating.
- Severity: Minor, Major, Severe.
- Penalty: Warning, DPC, QPC, GL, DQ.

The sample's wording differs ("Gameplay Error", "Game Loss"), but the report is read by a person, so
the wording doesn't matter (owner, 2026-10-13).

Discord modals take at most 5 inputs, and slash-command options can have autocomplete.

## Options considered

1. **`/penalty` with structured options + a short modal; the bot posts a card; the DB row is the
   source of truth.**
2. **Scrape free-text messages at close.** Lowest friction, but parsing is unreliable and the head judge
   has to clean up, which is the toil we're removing.
3. **Website-only form.** Exact data, but judges on the floor live in Discord on their phones.

## Decision

Option 1.

- **Command shape:** `/penalty round:<int> category:<autocomplete> severity:<Minor|Major|Severe>
  penalty:<autocomplete>`, offering the clipboard sheet's options (prize penalties only for TCG), opens a modal with **Competitor's Player ID** and **Notes**. The judge's
  player ID comes from the directory; a judge without one is told to `/link` first. Run in an event's
  penalty channel, the event is implied; elsewhere in the day, an `event:` option is required.
- **Stored as data**, one row per future CSV line. No competitor name is collected.
- **Edits and voids** are revisions (`penalty_revision`), never in-place loss:
  - The recording judge may edit for 15 minutes.
  - The event's head judges and the organizer may edit or void until the day is closed.
  - The bot edits the card to match.
- **The card is a view.** Deleting the message doesn't delete the penalty; "Repost card" restores it.
- **Catalog as data** (`penalty_category`, `penalty_type`, scoped by game and season), seeded with the
  clipboard sheet's labels (architecture §6.7) and editable in Settings. The CSV writes the same labels
  judges pick. A guideline change is an edit, not a release.
- **CSV writer** is pure (`shared/penalties/csv.ts`) and guarded by a golden file built from the sample:
  - the sample's columns and order;
  - quoting only when needed, LF line endings;
  - labels and notes verbatim (no formula prefixing).

  It refuses to export while an event lacks a Tournament ID.
- **Not collected:** the competitor's name and age division (on the clipboard sheet, not in the CSV).
- **Website parity:** head judges can view, add, edit and void on the website too.

## Consequences

- (+) The CSV is exact by construction; no end-of-day cleanup.
- (+) Fewer minors' data stored than free text would hold (no names).
- (+) Audit trail of every change.
- (−) Judges must learn one command, and must link a player ID once.
- (−) Discussion about a penalty still happens in free text; it lands in the transcript, not the CSV.
