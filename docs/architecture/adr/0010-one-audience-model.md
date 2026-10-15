# ADR-0010: One audience model for Discord and the website

- Status: Accepted (2026-10-13)
- Amended by [ADR-0015](0015-streaming-staff-role.md) (accepted 2026-10-15). Streaming staff are event staff
  who aren't judges: they record and list no penalties and see only `streaming` channels.
- Date: 2026-10-13

## Context

Genie decides "who may see this" in several places:

- the Discord overwrites provisioning writes (ADR-0005);
- the Discord interaction handlers (`/penalty`, card buttons, the `#head-judges` panel);
- the website's penalty pages, CSV downloads and transcript downloads (ADR-0004, ADR-0006, ADR-0007).

The first draft defined these separately and they disagreed. Penalties were scoped to *the event's* head
judges, but website access was given to any "head judge of a day", including anyone holding the mapped
head-judge Discord role who was on the day's staff. Exports, which include a transcript of every channel,
went to the day's head judges. So the VGC head judge could download the transcript of
`#tcg-lc-penalties`, a channel the owner deliberately keeps from them in Discord (architecture §15 Q2).
That is a privacy leak about named, often minor, players, the top-ranked quality attribute.

The owner decided on 2026-10-13 that head judges are scoped to **their event**.

## Options considered

1. **One pure audience function, derived from the same plan that provisioning applies, used by every
   website route and Discord handler.**
2. **Keep separate checks per surface, and align their wording.** Cheap now, but the next feature adds a
   third copy that can drift again.
3. **Widen Discord to match the website** (every head judge on the day sees every event's channels).
   Rejected by the owner; it reverses Q2.

## Decision

Option 1.

- **One function.** `shared/access.canSee(principal, resource, plan): boolean` is pure. It reads the
  day plan and the blueprint through the same `desiredChannels()` that provisioning applies (ADR-0005),
  so Discord and the website can't disagree.

  ```ts
  type Principal = { discordUserId: Snowflake; grants: Grant[] };
  type Grant = 'owner' | 'organizer_role' | 'allowlist'
    | { eventHeadJudge: EventId } | { dayStaff: DayId };
  type Resource =
    | { kind: 'channel' | 'thread'; dayId: DayId; blueprintKey: string; eventId?: EventId }
    | { kind: 'event_penalties'; eventId: EventId }
    | { kind: 'export_file'; fileId: string };
  ```

- **Rules:**
  1. **Never more than Discord.** A principal can see a resource on the website only if they are in the
     Discord desired audience of the channel it belongs to. Organizers are the only exception, matching
     their organizer-role overwrite.
  2. **Per-event resources** (an event's channels and their threads, transcripts, penalties, CSVs and
     voided CSVs) are visible only to that event's `headjudge` staffers and to organizers. Other event
     staff see the channels in Discord but get no website access.
  3. **Day-wide channel transcripts** go only to organizers and to head judges who are in that channel's
     audience.
  4. **The mapped head-judge role**, held by someone on the day's staff, makes them a *day head judge*.
     That grants `#head-judges` and the day's Sync and Close, and **no** other event's resources.
- **Organizers** are the install owner, plus holders of the mapped organizer role. When the owner
  enables the organizer allowlist (ADR-0004), organizers are `owner ∪ (organizer role ∩ allowlist)`.
  After close, only organizers can correct penalties (ADR-0006).
- **Administrators** (Discord's Administrator permission) see every channel whatever Genie does. They
  get nothing extra on the website, and the privacy audit reports them separately (ADR-0005).
- **Every check uses it:** `server/api/*` routes, `server/bot/*` handlers and the export download route
  call `canSee()`. No surface keeps its own copy of the rules.

## Consequences

- (+) The website can't show more than Discord does, by construction.
- (+) One pure function to property-test, at 95% branch coverage (architecture §11): for every principal
  and resource, website visibility implies membership of the desired audience.
- (+) New surfaces (a future report, an API) inherit the rules instead of restating them.
- (−) A head judge who also wants another event's report must be added as that event's head judge.
  That's intended.
- (−) The function needs the day plan at hand; handlers load it once per request.
