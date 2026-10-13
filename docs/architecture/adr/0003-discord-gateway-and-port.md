# ADR-0003: Discord through discord.js over the gateway, behind a `DiscordGateway` port

- Status: Proposed
- Date: 2026-10-13

## Context

Discord can deliver slash commands, buttons and modals two ways:

- over the bot's **gateway WebSocket**, or
- by POSTing to a public **interactions endpoint URL** that must answer within 3 seconds and verify
  Ed25519 signatures.

Genie runs on a home Unraid server, usually on a LAN or behind Tailscale, with no public HTTPS. The bot
also needs the gateway anyway for member data (the staff picker) and message content (transcripts).

Discord is the system's riskiest dependency for correctness: a permission mistake leaks a private
channel. That logic must be testable without a real guild, which Discord does not offer as a sandbox.

## Options considered

1. **discord.js v14 over the gateway**, wrapped in a narrow port.
2. **HTTP interactions endpoint** (+ REST for everything else). Stateless and serverless-friendly, but
   needs public HTTPS, signature checks and a 3 s answer budget; still needs the gateway for intents.
3. **A thinner library (e.g. `@discordjs/core` + `@discordjs/rest`) or raw REST.** Fewer abstractions,
   but reimplements caching, reconnects and rate-limit buckets that discord.js already gets right.

## Decision

Option 1.

- **The port.** All Discord calls go through `DiscordGateway` (architecture §4.1). Only
  `server/modules/discord/adapters/discordjs/` imports discord.js, enforced by ESLint. Inbound
  interactions are converted to plain `InboundInteraction` values before they reach `server/bot/`.
- **The fake.** An in-memory fake of the port models guilds, members, roles, channels, threads and
  overwrites. It computes effective permissions in Discord's documented order:
  1. guild base permissions of `@everyone` and the member's roles, where Administrator grants everything;
  2. the channel's `@everyone` overwrite;
  3. its role overwrites;
  4. the member overwrite.

  It models View Channel, Read Message History, Send Messages, Send Messages in Threads, Create
  Public/Private Threads and Add Reactions, not View alone. Privacy and lock tests run against it.
- **The fake's oracle is recorded reality.** Spike S3 delivers a set of **recorded permission cases**:
  JSON fixtures of a guild, roles, overwrites, member and channel, each with the effective permissions
  observed on a real test guild. One table-driven contract suite runs those cases:
  - against the fake, in CI;
  - against the discord.js adapter, on the test guild before each release and whenever the cases change.

  A case may only be added or changed together with a real-guild observation. That way the fake can't
  quietly encode the same wrong assumption as the design.
- **Commands** are guild-scoped and registered on every boot from a single definition list.
- **Bound guild only.** Setup refuses to finish while the application's "Public Bot" flag is on
  (`getApplication().botPublic`). The interaction router drops, and logs, any interaction from another
  guild and any DM. Finding itself in an extra guild is a page-header warning, not a boot failure.
- **Every handler authorizes from Genie's data** through `canSee()` (ADR-0010), not from Discord
  command permissions alone.
- **Interaction replies** are deferred whenever work may exceed Discord's 3-second window.

## Consequences

- (+) No public endpoint, no signature handling; works on a LAN install.
- (+) Rate limits, reconnects and gateway resumes are handled by a maintained library.
- (+) Channel-privacy logic is tested deterministically against the fake.
- (−) The fake can drift from real Discord behaviour. Mitigated by building its cases from S3's
  real-guild observations and running the same suite against the adapter before each release and on every
  case change. Recording a case still needs a person and a test guild.
- (−) Needs two privileged intents (GuildMembers, MessageContent); fine under 100 guilds, checked at setup.
- (−) A long-lived WebSocket ties Genie to a long-running host (already true by ADR-0001).
