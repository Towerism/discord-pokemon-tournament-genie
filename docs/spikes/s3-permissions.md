# S3: permissions in a real guild

Does Genie's permission design ([architecture §4.1, §6.3, §6.5](../architecture/README.md)) hold on a real
Discord guild, and what are the recorded cases the fake gateway must reproduce (§11,
[ADR-0003](../architecture/adr/0003-discord-gateway-and-port.md))?

- **Recorded:** 2026-10-14, discord.js 14.27.0, API v10, guild `genie-spike-<name>` (throwaway).
- **Runs:** two agreeing passes `20261014075104-8020` and `20261014075549-c6a7` (47 cases each: 19 write
  cases, 28 effective cases), about 9.5 minutes for both (under the 20-minute target). An earlier pass,
  `20261014073111-0567`, ran against the architecture's original profile and stopped with exit 7
  (`profile_unwritable`); see [Why the original profile was refused](#why-the-original-profile-was-refused).
- **Fixture:** [`test/fixtures/discord-permissions/cases.v1.json`](../../test/fixtures/discord-permissions/cases.v1.json)
  and its schema. Each case carries the overwrites as Discord stored them, the observed actions, the
  derived effective permissions, and discord.js's computed view beside them.
- **Profile recorded:** the **candidate** profile, not the accepted one. `genie`'s own overwrite allows
  View, Send and Manage Channels, without Manage Roles, and its invite set is §4.1's nine permissions plus
  Send Messages in Threads, Create Public Threads, Create Private Threads and Add Reactions (13 in all).
  The amendment that makes this the architecture is
  [ADR-0012](../architecture/adr/0012-genie-overwrite-without-manage-roles.md), accepted by the owner on
  2026-10-14.

## Answers to the §13 questions

| §13 question | Answer | Cases |
| ------------ | ------ | ----- |
| Can `genie` write its profiles at all, without Administrator? | **Not the accepted one.** With §4.1's nine permissions, every write of the original profile was refused (403, code 50013), on create and on the create-then-edit fallback. The candidate profile was written on every production path under both guild bases: create category, create channel, sync onto an open channel, the fallback onto a bare channel, and the lock. | `W0-*`, `W1-*`, `W2-*`, `W6-default-original` |
| Bot role position vs. member overwrites | Role position doesn't limit overwrites. `genie` wrote a role overwrite for a role above its own (`W3`) and a member overwrite for a member whose top role is above its own (`W4`). Both stored as written. | `W3-default-edit`, `W4-default-edit` |
| Category vs. channel overwrites | A channel created under the category **without** its own overwrites inherited the category's, and an outsider couldn't see it (`R8`). A channel whose overwrites `genie` wrote **without** the `@everyone` deny was visible to an outsider, even though the category denies it (`R9`). That confirms §6.3's rule: deny `@everyone` View on the category **and** on every channel, and never rely on category sync. | `R8-*`, `R9-default-category-outsider` |
| Guild base with and without Send (`@everyone`) under the open overwrites | Outsiders see nothing under either base (`R1`). Staffers can view, read and send under both (`R2`). Under the no-send base, though, a staffer **can't create threads or react** in an open channel: the staffer overwrite allows View, Send, Read History and Attach Files only, and the base no longer grants the rest. | `R1-*`, `R2-*`, `R3-default-open-organizer` |
| Under the locked overwrites | The lock holds under both bases: staffers and organizers keep View and Read History and lose Send, thread creation and reactions (`R4`, `R5`). A member whose **role** grants Send under the no-send base is still locked, because the member overwrite's denies win (`R7`). | `R4-*`, `R5-default-locked-organizer`, `R7-nosend-locked-sendrole` |
| Thread permissions | In an open channel, a staffer can view, read, send in and react in public threads and private threads they were added to (`R10`, `R11`). A staffer **not added** to a private thread can't see it, and an outsider can't see a public thread in a channel they can't see. The lock covers threads: staffers can't send in or react in a locked channel's threads. Archived threads refuse reactions with "thread archived", for everyone. | `R10-*`, `R11-*`, `R12-*` |
| What an Administrator still sees | Everything, and an Administrator can still send, create threads and react in locked channels and their threads, under both bases. As §6.5 expects, only the purge's high-water check catches their messages. | `R6-*`, `R12-default-locked-admin-*` |

### Effective permissions per case

`Y` allowed, `n` denied, `?` unobservable for that target (see the action-to-permission table in issue #7's spec).

| Case | View | History | Send | Send in threads | Public thread | Private thread | React |
| ---- | ---- | ------- | ---- | --------------- | ------------- | -------------- | ----- |
| `R1-default-open-outsider` | n | n | n | n | n | n | n |
| `R1-default-locked-outsider` | n | n | n | n | n | n | n |
| `R1-nosend-open-outsider` | n | n | n | n | n | n | n |
| `R1-nosend-locked-outsider` | n | n | n | n | n | n | n |
| `R2-default-open-staffer` | Y | Y | Y | ? | Y | Y | Y |
| `R2-nosend-open-staffer` | Y | Y | Y | ? | n | n | n |
| `R3-default-open-organizer` | Y | Y | Y | ? | Y | Y | Y |
| `R4-default-locked-staffer` | Y | Y | n | ? | n | n | n |
| `R4-nosend-locked-staffer` | Y | Y | n | ? | n | n | n |
| `R5-default-locked-organizer` | Y | Y | n | ? | n | n | n |
| `R6-default-open-admin` | Y | Y | Y | ? | Y | Y | Y |
| `R6-default-locked-admin` | Y | Y | Y | ? | Y | Y | Y |
| `R6-nosend-open-admin` | Y | Y | Y | ? | Y | Y | Y |
| `R6-nosend-locked-admin` | Y | Y | Y | ? | Y | Y | Y |
| `R7-nosend-locked-sendrole` | Y | Y | n | ? | n | n | n |
| `R8-default-category-staffer` | Y | Y | Y | ? | Y | Y | Y |
| `R8-default-category-outsider` | n | n | n | n | n | n | n |
| `R9-default-category-outsider` | **Y** | Y | Y | ? | Y | Y | Y |
| `R10-default-open-staffer-public` | Y | Y | ? | Y | ? | ? | Y |
| `R10-default-open-outsider-public` | n | n | n | n | n | n | n |
| `R11-default-open-staffer-private-added` | Y | Y | ? | Y | ? | ? | Y |
| `R11-default-open-staffer-private-notadded` | n | n | n | n | n | n | n |
| `R12-default-locked-staffer-public` | Y | Y | ? | n | ? | ? | n |
| `R12-default-locked-staffer-public-archived` | Y | Y | ? | n | ? | ? | ? |
| `R12-default-locked-staffer-private-added` | Y | Y | ? | n | ? | ? | n |
| `R12-default-locked-admin-public` | Y | Y | ? | Y | ? | ? | Y |
| `R12-default-locked-admin-public-archived` | Y | Y | ? | Y | ? | ? | ? |
| `R12-default-locked-admin-private-added` | Y | Y | ? | Y | ? | ? | Y |

`R9` is the one channel an outsider can see, and it is the case built to show why: its overwrites omit
the `@everyone` deny.

## Why the original profile was refused

The first pass (`20261014073111-0567`) used the architecture's profile, in which `genie`'s own channel
overwrite also allows Manage Roles. With §4.1's nine permissions, Discord refused (403, code 50013) every
write of that profile that didn't already find `genie`'s Manage Roles overwrite on the channel: all four
`W0` creates and the `W1`/`W2` writes onto a bare channel. Every write onto a channel that already carried
that overwrite succeeded. Both production paths were refused, so the run stopped before the R cases.

The diagnostic cases in the recorded passes isolate the rule. Both passes agree:

| Case | What `genie` writes | Result | Reading |
| ---- | ------------------- | ------ | ------- |
| `W6-default-control` | its candidate overwrite only (View, Send, Manage Channels) | ok | the candidate is writable; nothing else is wrong |
| `W6-default-mrself` | an overwrite allowing itself Manage Roles, and nothing else | **refused** | a non-admin bot can't put Manage Roles in a channel overwrite. This is what refused the original profile |
| `W6-default-lacksallow` | a member overwrite allowing Mention Everyone, which `genie` doesn't hold | **refused** | `genie` can only allow permissions it holds |
| `W6-default-lacksdeny` | a member overwrite **denying** Mention Everyone | **refused** | it can't deny them either. So the four permissions the lock denies (§6.5) must be in `genie`'s invite set: under a no-send base `genie` holds them only through its role |
| `W5-default-edit` | the same unheld allow, on an existing channel | **refused** | the hold-it rule applies on edit too |
| `W6-default-original` | the original open profile | **refused** | the original refusal, kept in the fixture |
| `W7-default-originalmr` | the original profile, after an administrator placed `genie`'s Manage Roles overwrite | ok | an owner-placed overwrite would unlock the original profile (the rejected option 2 in ADR-0012) |

So two Discord rules apply to a bot without Administrator:

1. it can't grant Manage Roles in a channel overwrite unless that channel already gives it Manage Roles;
2. it can only allow or deny permissions it holds itself.

The accepted design breaks both: §6.3 has `genie` allow itself Manage Roles, and §6.5's lock denies four
permissions §4.1 doesn't grant. [ADR-0012](../architecture/adr/0012-genie-overwrite-without-manage-roles.md)
proposes the fix the candidate recorded: drop Manage Roles from `genie`'s overwrite (its guild role keeps
Manage Roles, which is what lets it write overwrites at all), and add the four permissions to the invite.

## Observations that contradict the architecture

| Observation | Contradicts | Amendment (accepted) |
| ----------- | ----------- | ------------------ |
| `genie` can't allow itself Manage Roles in a channel overwrite | §6.3 ("the bot allow View/Send/Manage"), ADR-0005 | ADR-0012: `genie`'s overwrite allows View, Send, Manage Channels |
| `genie` can't deny permissions it doesn't hold, and the lock denies four that §4.1 doesn't grant | §4.1's invite set, §6.5's lock | ADR-0012: invite set grows to 13 |
| A member who can't view a channel has no other permission in it, whatever the bits say (see below) | §4.1's resolution order, which the fake follows, doesn't state this | ADR-0012 adds the rule to §4.1 |
| Existing reactions stay clickable after the lock denies Add Reactions (`reactExisting` was allowed in every locked case where the subject can view, except archived threads) | §6.5's "nobody but the bot can add anything" | §6.5 now says reactions on existing emoji still work. Reactions aren't messages, so the purge's high-water check isn't affected |

Not contradictions, recorded for later milestones:

- Under a no-send guild base, staffers can't create threads or react in open channels (`R2-nosend`). The
  architecture doesn't promise either. If stores want threads in day channels, the staffer overwrite
  would have to allow them; that is a product decision for M3, not an M0 amendment.
- §6.3's rule to deny `@everyone` View on every channel, not only the category, is confirmed by `R9`.

## Library vs. observed

discord.js's `permissionsFor()` (`computedByLibrary`) disagreed with the effective permissions in 21
places, all of the same kind: an outsider who **can't view** the channel (`R1-*`, `R8`-outsider,
`R10`-outsider). The library reports the underlying bits (for example Send Messages, Read History, Add
Reactions from the `@everyone` base) as granted, while Discord refuses every action, because without View
a member has no access to anything in the channel. The library and Discord agreed on View itself in every
case.

**Privacy-audit implication.** §6.3's audit computes effective View, which the library gets right. Any
check that reads another permission (for example "can this member post here?") must first require View,
or it will report outsiders as able to post. The fake gateway's permission model (M2) must apply the same
rule. ADR-0012 adds it to §4.1's resolution order.

The private-thread cases with the subject not added (`R11-default-open-staffer-private-notadded`) report
View as false through membership, not a permission bit; as the spec expects, that isn't counted as a
disagreement.

## Human cross-check

**Done, 2026-10-14: all four cases agree with the recording.** The owner staged each case for an alt
account with `pnpm spike s3 stage --case <id> --subject-user <alt account's user ID>`, tried the printed
actions in order as the alt account in the Discord client, and the harness cleaned up each run afterwards
(`pnpm spike cleanup --run <runId>`).

| Case | Agrees with the recording? | What the alt account could do |
| ---- | -------------------------- | ----------------------------- |
| `R1-nosend-open-outsider` | yes | Couldn't see the channel, so no other action was possible. Recorded: all seven denied. |
| `R2-default-open-staffer` | yes | All seven actions worked. Recorded: all allowed. |
| `R4-nosend-locked-staffer` | yes | View, read history and react with the existing 👍 worked; a new reaction, both thread kinds and sending didn't. Recorded: the same. |
| `R11-default-open-staffer-private-notadded` | yes | Couldn't see the private thread; none of the five thread actions worked. Recorded: all denied. |

So the bot-probe method held for every action the cross-check covered, and no case needs dropping or
re-recording.

A disagreement means the bot-probe method is unsound for that action, and the case must be dropped or
corrected (and the fixture re-recorded) before M0 merges.
