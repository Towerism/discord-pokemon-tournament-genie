# ADR-0005: Fresh channels per day, provisioned as desired state with member overwrites

- Status: Proposed
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
- **Overwrites are computed and replaced whole:**
  - `@everyone` deny View, set on the category *and* every channel, so nothing relies on category sync;
  - the bot allowed View, Send and Manage;
  - the organizer role allowed View;
  - one member overwrite per staffer in the channel's audience.

  `setOverwrites` replaces the full list, so applying twice changes nothing and manual edits are reverted.
- **The job** (`provision`, and `sync` for changes) runs on rails like attendance's submission jobs:
  - a per-day lease;
  - an event log with SSE progress;
  - boot recovery;
  - retry that re-reads before acting.

  The steps are plan → apply (one call at a time, checkpoint after each) → reconcile. The reconcile re-reads
  every channel and checks that the effective audience equals the desired one. Any mismatch fails the job.
- **Drift:** a channel missing from Discord is recreated, and one in the category that Genie didn't
  record is reported, never deleted automatically.
- **Preconditions** are checked before opening: every day staffer has a linked Discord member, the bot
  has its permissions and role position, and the guild channel limits leave room.

## Consequences

- (+) Idempotent and crash-safe; mid-day changes are "edit the plan, Sync".
- (+) No leftover roles; teardown is deleting recorded channels.
- (+) The privacy rule is one pure function plus an audit, both heavily tested.
- (−) Adding a staffer mid-day rewrites overwrites on several channels (a few REST calls, rate-limited but fine).
- (−) Member overwrites cap at 500 per channel, far above a store's staff.
- (−) Guild members with Administrator see everything regardless; documented, out of Genie's control.
