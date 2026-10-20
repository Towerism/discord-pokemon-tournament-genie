# ADR-0017: Deliver attendance's messages as Discord direct messages through a long poll

- Status: Accepted (2026-10-20)
- Date: 2026-10-20
- Issue: [#51](https://github.com/Towerism/discord-pokemon-tournament-genie/issues/51), whose spec has the
  requirements and tests
- Companion: attendance's [ADR-0015 §7](https://github.com/Towerism/play-pokemon-attendance-web/blob/main/docs/architecture/adr/0015-professor-logins.md),
  live since attendance v1.29.0, which fixes the wire. This ADR is Genie's side of it, as ADR-0008 was Genie's side
  of attendance's ADR-0013.

## Context

Attendance v1.29.0 added professor logins (its M10, tracked in
[play-pokemon-attendance-web#204](https://github.com/Towerism/play-pokemon-attendance-web/issues/204)). The owner
invites a professor by player ID, and attendance hands the invite link to Genie to send as a Discord direct message (DM).
Tournament-lease notices use the same channel. Until Genie takes part, attendance's **Send by Discord** says "Genie
isn't connected", and the owner copies links by hand.

Attendance's channel is low level and knows no features:

- `GET /api/integrations/v1/messages?wait=&limit=` is a long poll. It answers as soon as a message can be handed out,
  or after `wait` seconds (at most 25) with none. A handed-out message is hidden for 60 s.
- `POST /api/integrations/v1/messages/{id}/result { status, reason? }` takes `delivered`, `no_discord_user`,
  `dm_refused` (all final) or `failed` (retried, `undeliverable` after 5).
- Both need an integration token with the `messages:deliver` scope. Polls are limited to 120 and results to 600 per
  15 minutes per token.
- Attendance treats Genie as unavailable after 2 minutes without a poll, and waits up to 10 s for an invite's result.
- Delivery is at least once: a message stays pending until Genie reports it.

Genie already holds attendance's base URL and a sealed token for the day import (ADR-0008), and its directory maps
player IDs to Discord users (architecture §5.3). Attendance never learns Discord IDs.

## Options considered

1. **Long poll from Genie, one token, DM only to confirmed links, one message holding the text, then the link.**
2. **A second token only for messages.** Least privilege, but a second field in Settings and a second secret to
   rotate, for one owner on one local network (LAN).
3. **Treat a `claimed` directory row as a recipient.** Reaches more people, but a claim is unconfirmed by design
   (§5.3), and the message can carry a secret invite link.
4. **The link as a button under the text.** Tidier, but departs from ADR-0015 §7's "the text, then the link", and
   Discord caps a button's URL at 512 characters, which attendance doesn't. A long URL would fail every time until
   attendance gave up and revoked the invite.
5. **Text and link as two messages.** Also "text, then the link", but a failure between the two leaves a DM without
   its link and no clean status to report.
6. **Poll even while the bot is down, and report `failed`.** Keeps attendance's presence green, but burns each
   message's retries and makes attendance say Genie is connected when it can't deliver.

## Decision

Option 1.

- **A loop, not a job.** The `message-delivery` module runs one loop in the server process. It keeps a poll open only
  while setup is complete, an attendance connection is saved, and the bot is connected. The bot runner reports its
  state without calling Discord (`isConnected()`, `onStateChange`), and the loop polls the moment the bot connects.
  A plugin that sorts before `03.bot.ts` starts the loop, and on shutdown stops it before the bot logs out.
- **One token.** The attendance connection's token serves both the day import and the poll. The owner mints it with
  both scopes. Settings names the fix when the token lacks `messages:deliver`.
- **Who gets a DM.** Only the staff member whose player ID matches and whose Discord link the organizer confirmed
  (`link_state = 'linked'`). Anyone else is reported `no_discord_user`, and nothing is sent.
- **What the DM says.** The text, a blank line, then `label: url`, in one message. No allowed mentions, and link
  previews suppressed, so Discord's crawler never fetches an invite. It is never posted in a guild channel. A link that
  isn't `http(s)`, or content over Discord's 2,000 characters, is reported `failed` and not sent.
- **Discord's answers.** Discord's 50007 is `dm_refused`; 10013 and 50033 are `no_discord_user`. These are read before
  the adapter's general mapping, which would otherwise call a refused DM an outage. Any other failure is `failed`
  with a plain code as the reason.
- **At least once, without double sends.** Each final outcome is recorded in `delivered_message` before it is
  reported, keyed by a hash of the base URL and the message ID. A message attendance hands out again is reported from
  the record, not sent again. Records are deleted after 30 days, as attendance deletes its messages.
- **A batch belongs to its connection.** Saving or removing the connection drops the batch in hand: nothing more of it
  is sent, recorded or reported. Removing a connection deletes its records.
- **Staying inside attendance's limits.** A refusal the organizer must fix is retried every 5 min. An outage backs off
  from 5 s, doubling up to 60 s. A 429 waits `Retry-After`. An empty answer that came back at once is followed by a
  pause that fills out 5 s. Genie also counts its own polls and starts no more than 110 in any 15 minutes. No send
  starts 60 s after a poll answered, so a slow Discord can't lapse the 2-minute presence. A report that fails with an
  outage is retried after 1, 2 and 4 s; anything else is left for attendance to hand out again.
- **Nothing secret is kept or logged.** The text, link, player ID and Discord user are never stored or logged. Logs
  carry the message ID and the status. The redactor also hides `text`, `link` and `linkUrl`.

## Consequences

- (+) M10's invites and lease notices reach professors in Discord, and attendance stays unaware of Discord IDs.
- (+) A new use of attendance's channel needs no change in Genie.
- (+) Settings shows whether delivery works and, if not, what to fix.
- (−) The day-import token now also receives undelivered invite and reset links, and can report false results. A false
  `no_discord_user` revokes an invite. It is sealed in Genie's vault and revocable in attendance. A separate token
  (option 2) stays open as a later change.
- (−) An `http://` attendance address carries the links and the token in clear text on the LAN. Genie accepts that for
  a LAN install, as attendance itself does.
- (−) Genie trusts attendance as its owner's own app: a compromised attendance could DM linked staff any text. It would
  arrive as plain bot text, with no pings, and only to linked staff. Revoking the token or removing the connection
  stops it.
- (−) Delivery is at least once. A DM can repeat when Genie crashes between sending and recording it, or when a send
  times out after Discord created the message (discord.js retries it, or Genie reports `failed` and sends again on the
  next hand-out). A repeated invite is harmless: the link is the same and single use.
- (−) Restoring attendance from a backup at the same address brings back old message IDs, and reinstalling it there
  numbers its messages from 1 again. For up to 30 days Genie would answer those IDs from its records, reporting
  `delivered` without sending. After a restore or a reinstall, the owner removes Genie's attendance connection and saves
  it again, which clears those records. Keying the records on an attendance instance ID, if attendance ever offers
  one, would remove this step.
- (−) Two Genie processes on one token can pass attendance's poll limit together. That setup isn't supported.
