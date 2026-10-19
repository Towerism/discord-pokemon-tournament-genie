# ADR-0016: The invite asks for Pin Messages; a day opens and closes without it

- Status: Accepted (2026-10-19, owner approval of the spec on [#46](https://github.com/Towerism/discord-pokemon-tournament-genie/issues/46))
- Amends [ADR-0012](0012-genie-overwrite-without-manage-roles.md) (the invite set) and architecture §4.1
- Date: 2026-10-19

## Context

Provisioning posts an intro in the day's all-staff channel and pins it (§6.3). Every sync of an open day
logged "Couldn't post or pin the intro; the next sync tries again." The post worked; the pin never did.

None of ADR-0012's 13 invite permissions allows pinning. Discord split Pin Messages (bit 51) out of Manage
Messages on 2025-08-20 and requires it for pins from 2026-02-23
([discord-api-docs #8002](https://github.com/discord/discord-api-docs/pull/8002)). Genie's own channel
overwrite can't grant it either, because a bot without Administrator can only allow what its role holds
(ADR-0012). So the pin was refused, the intro stayed unpinned, and every sync tried again.

## Options considered

1. **Add Pin Messages to the invite.** It is the narrowest permission that allows pinning.
2. **Add Manage Messages.** Rejected: since 2026-02-23 it no longer allows pinning on its own, and it would
   let the bot delete anyone's messages.
3. **Stop pinning the intro.** Rejected: the pin keeps the "how to use this day" message at hand in a busy
   channel, and the fix is one permission.

## Decision

Option 1.

- The invite set is ADR-0012's 13 plus **Pin Messages** (14 in all). The invite URL, the setup wizard's
  permission check, the status banner and the sync's "The bot lacks …" warning all cover it.
- **Opening and closing a day don't require it.** Without Pin Messages a day still works; only the intro
  stays unpinned. Both checks use `missingDayPermissions` in `shared/discord/permissions.ts`, the invite set
  minus Pin Messages, so an install whose bot was invited before this change isn't blocked mid-tournament.
- When Discord refuses the pin, the sync warns "Couldn't pin the intro: the bot needs the Pin Messages
  permission. Add it to Genie's role; the next sync pins it." The sync still succeeds.

## Consequences

- (+) Once the bot's role holds Pin Messages, the next sync pins the intro already posted and the warnings
  stop.
- (−) An existing install's owner has to add Pin Messages to Genie's role by hand (during setup, opening
  the invite link again does it), then press **Sync** on any open day. `docs/deploy.md` has the steps. Until then each sync logs two
  warnings: the missing permission and the refused pin.
- (−) Pin Messages also lets the bot unpin other people's pins in channels it can see. Genie only pins its
  own intro.
- Spike S3's real-guild cases were recorded with the 13 permissions, and none involves Pin Messages. The
  contract suite keeps checking the test guild's bot role against those 13.
