# ADR-0012: Genie's channel overwrite without Manage Roles, and an invite set that covers the lock

- Status: Proposed (M0 finding, awaiting owner acceptance)
- Amends [ADR-0005](0005-channels-as-desired-state.md) and architecture §4.1, §6.3, §6.5
- Date: 2026-10-14

## Context

Spike S3 ([findings](../../spikes/s3-permissions.md)) recorded Genie's permission design on a real guild,
with a `genie` bot holding exactly §4.1's invite permissions and no Administrator. The accepted design
couldn't be written:

- **Provisioning.** §6.3 and ADR-0005 have the bot's own channel overwrite allow View, Send and "Manage",
  including Manage Roles. Discord refused (403, code 50013) every create of a category or channel with
  that overwrite, and every write of it onto a channel that didn't already carry it. The diagnostic case
  `W6-default-mrself`, an overwrite in which `genie` allows itself Manage Roles and nothing else, was
  refused too, while `W6-default-control` (the same overwrite without Manage Roles) was accepted. A bot
  without Administrator can't grant Manage Roles in a channel overwrite unless the channel already gives
  it Manage Roles.
- **The lock.** §6.5's lock denies Send Messages in Threads, Create Public Threads, Create Private Threads
  and Add Reactions, none of which §4.1's invite grants. `W6-default-lacksallow` and
  `W6-default-lacksdeny` showed that `genie` can neither allow nor **deny** a permission it doesn't hold.
  Under a guild whose `@everyone` base lacks those permissions, the lock would be refused.
- **Resolution order.** §4.1 describes the four-step resolution order, which the fake gateway follows.
  In every case where a member couldn't view a channel, Discord refused every other action too, while
  discord.js still reported the underlying bits (21 disagreements, all of this kind).

S3 then recorded a candidate profile (below). It was written on every production path (create category,
create channel, sync, the create-then-edit fallback, and the lock) under both guild bases, in two
agreeing passes.

## Options considered

1. **Drop Manage Roles from Genie's own overwrite, and add the four lock permissions to the invite.**
   Genie keeps Manage Roles from its **guild role**, which is what lets it write overwrites at all; its
   own channel overwrite allows View, Send and Manage Channels. Recorded by S3 and accepted on every path.
2. **Keep the overwrite; have the owner place it.** An administrator puts Genie's Manage Roles overwrite
   on each category or channel, after which Genie can write the original profile (`W7-default-originalmr`
   was accepted). Rejected: Genie creates fresh channels every day (ADR-0005), so this would be a manual
   step per day, or Genie would need Administrator to do it.
3. **Invite Genie with Administrator.** Rejected: it contradicts §4.1's least-privilege invite, and an
   Administrator bot sees and can do everything, which weakens the privacy argument the audit rests on.

## Decision

Option 1.

- **Genie's own overwrite**, on the category and every channel, allows **View Channels, Send Messages and
  Manage Channels**. It does not allow Manage Roles. Everything else in the open, locked and category
  overwrites is unchanged.
- **The invite set** is §4.1's nine permissions plus the four the lock denies: Send Messages in Threads,
  Create Public Threads, Create Private Threads and Add Reactions (13 in all). Genie can only allow or deny
  permissions it holds, and under a no-send `@everyone` base it holds these four only through its role.
  The setup wizard's permission check covers all 13.
- **Resolution order.** §4.1 adds the implicit rule: a member who can't view a channel has no other
  permission in it, whatever the computed bits say. The privacy audit and the fake gateway apply it, so a
  check such as "can this member post here?" requires View first.

## Consequences

- (+) Provisioning, sync and the lock work for a bot without Administrator, on both guild bases, as
  recorded in the S3 fixture that M2's fake is tested against.
- (+) No manual per-day step, and no Administrator.
- (−) The invite asks for four more permissions. All four are thread and reaction permissions that
  `@everyone` usually has anyway.
- (−) Genie's channel overwrite no longer grants it Manage Roles in its own channels. Writing overwrites
  doesn't need it, because the guild role's Manage Roles suffices for permissions Genie holds (S3: sync,
  fallback and lock all succeeded). If a later feature needs Genie to grant a permission it doesn't hold,
  that feature needs a new ADR.
- Existing reactions stay clickable after the lock denies Add Reactions (S3, `reactExisting`). Reactions
  aren't messages, so the purge's high-water check isn't affected; §6.5 says so.
