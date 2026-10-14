# ADR-0005: Fresh channels per day, provisioned as desired state with member overwrites

- Status: Accepted (2026-10-13)
- Amended by [ADR-0011](0011-share-infrastructure-through-selfhost-kit.md) (proposed 2026-10-13)
- Date: 2026-10-13

## Context

Each event day needs a set of private channels: some for the whole day and some for each event. Only
that day's staff may see them, and some channels (head judges, penalties) narrow further. Staff and
events change during the day. Reusing past channels is explicitly unwanted. A permission mistake is the
worst outcome (architecture §2, attribute 1), and Discord calls can fail half way or hit rate limits.

Ways to grant access:

- **a temporary role per day:** one role overwrite per channel, and access means adding the role to members;
- **one member overwrite per staffer per channel.**

## Options considered

1. **Desired state + reconcile job, member overwrites, a fresh category per day.** The day plan and a
   blueprint define exactly which channels should exist and who sees each. A job creates and corrects
   them, recording each channel ID as soon as it exists.
2. **Imperative scripts per action** ("create channels", "add judge") with no reconcile. Simple at
   first, but a crash or manual edit leaves unknown state.
3. **A temporary Discord role per day (and per audience).** Fewer overwrites, but it needs the bot's role
   above the role it manages. It also leaves roles behind if teardown fails, shows up in members'
   profiles, and multiplies with per-event audiences.

## Decision

Option 1.

- **Fresh per day.** Opening a day always creates a new category and channels. Genie owns only channels
  recorded in `provisioned_channel` and never touches any other channel.
- **Blueprints are data.** Channel name patterns, scope (day / per event), kind (text / voice), audience
  (all staff, event staff, head judges) and purpose (general, floor, penalties).
  `shared/blueprints.desiredChannels(day)` is a pure function used by both the preview and the job.
- **Overwrites are designed against Discord's resolution order.** Discord applies the guild base
  permissions (`@everyone` and the member's roles; Administrator overrides everything), then the channel's
  `@everyone` overwrite, then role overwrites, then the member overwrite. A bit left out of an allow list
  is therefore not denied, so anything that must be off is an explicit deny (the lock in ADR-0007).
- **Overwrites are computed and replaced whole:**
  - `@everyone` deny View, set on the category *and* every channel, so nothing relies on category sync;
  - the bot allowed View, Send and Manage;
  - the organizer role allowed View;
  - one member overwrite per staffer in the channel's audience.

  `setOverwrites` replaces the full list, so applying twice changes nothing and manual edits are reverted.
  The same plan feeds `canSee()` (ADR-0010), so the website never shows more than these overwrites allow.
- **The job** (`provision`, and `sync` for changes) runs in Genie's own `jobs` module:
  - a per-day lease;
  - an event log with SSE progress;
  - boot recovery;
  - retry that re-reads before acting.

  The steps are plan → apply (one call at a time, checkpoint after each) → reconcile → audit.
- **The privacy audit** re-reads every channel and computes each guild member's effective View:
  - members with Administrator, and members of the organizer role, are left out of the comparison and
    reported separately in the job log ("also visible to: N administrators, M organizers");
  - any other difference between the effective audience and the desired one, extra or missing, fails
    the job.
- **Removals don't wait.** A change that takes access away (removing a staffer from the day or an event,
  a narrowing role change, or an accepted attendance refresh that does either) queues a `sync` at once.
  A failed or interrupted sync with pending removals:
  - is retried automatically at boot;
  - shows an "access not yet revoked" alarm to organizers until a sync succeeds.

  Additions still wait for the organizer's Sync.
- **Drift:** a channel missing from Discord is recreated, and one in the category that Genie didn't
  record is reported, never deleted automatically.
- **Preconditions** are checked before opening: every day staffer has a linked Discord member, every
  event's game is confirmed, the bot has its permissions and role position, and the guild channel limits
  leave room.

## Consequences

- (+) Idempotent and crash-safe; mid-day changes are "edit the plan, Sync".
- (+) No leftover roles; teardown is deleting recorded channels.
- (+) The privacy rule is one pure function plus an audit, both heavily tested.
- (−) Adding a staffer mid-day rewrites overwrites on several channels (a few REST calls, rate-limited but fine).
- (−) Member overwrites cap at 500 per channel, far above a store's staff.
- (−) Guild members with Administrator see everything regardless; documented, out of Genie's control,
  and listed by the audit rather than hidden.
