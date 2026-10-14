# ADR-0014: `/penalty` takes category, severity and penalty as selects in the modal

- Status: Accepted (2026-10-14, M0 finding)
- Amends [ADR-0006](0006-structured-penalties.md) and architecture §6.4 and §12
- Date: 2026-10-14

## Context

ADR-0006 and §6.4 design `/penalty` as command options (`round`, `category`, `severity`, `penalty`, the
last with autocomplete) followed by a modal with two text inputs: the competitor's player ID and notes.
§13's spike S2 compared that with Discord's newer select-in-modal components, timing a judge on a phone.

S2 ([findings](../../spikes/s2-penalty-form.md)), iPhone 17 Pro Max, 5 successful runs per form:

- **Options + 2-field modal (as designed):** median 43.3 s, max 54.9 s.
- **`round` option + modal with three selects, player ID and notes:** median 35.8 s, max 37.9 s.
- Both forms worked on iOS with no errors. One device and one judge; all runs of the first form were
  made before the second.

## Options considered

1. **Selects in the modal** (category, severity, penalty as string selects; player ID and notes as text
   inputs); `round`, and `event` in a day-wide channel, stay command options. Faster and more consistent
   in S2. Uses all five modal components.
2. **Keep options + a 2-field modal** (as accepted). About 7.5 s slower per penalty at the median in S2,
   with a much wider spread; leaves three modal components free.

## Decision

Option 1 (accepted by the owner, 2026-10-14).

- `/penalty` keeps `round` (and `event` where §6.4 needs it) as command options.
- Its modal has five `Label` components: three string selects (category, severity, penalty) and two text
  inputs (player ID, validated as digits; notes, optional).
- The bot builds the modal when the command runs, so the penalty select lists only the penalties valid for
  the event's game (no prize penalties outside TCG), as autocomplete did.
- Everything else in ADR-0006 is unchanged: the card, Edit / Void, idempotency key, revisions, the CSV.

## Consequences

- (+) Faster, more predictable recording on a phone, which is what G4 and quality goal 3 (one command and
  one short form) are about.
- (−) The modal is full: any new per-penalty field must become a command option or replace one of the
  five components.
- (−) Each select holds at most 25 options. The clipboard sheet's lists are well under that; a catalog that
  outgrows it would need grouping.
- (−) The evidence is one device and one judge. M4 can re-time on an Android phone before shipping if the
  owner wants more than S2's minimum.
