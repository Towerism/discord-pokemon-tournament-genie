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
- **The fake.** An in-memory fake of the port, kept in step with the adapter by a shared contract test
  suite, models guilds, members, roles, channels, overwrites and effective View permission. Privacy
  tests run against it.
- **Commands** are guild-scoped and registered on every boot from a single definition list.
- **Every handler authorizes from Genie's data**, not from Discord command permissions alone.
- **Interaction replies** are deferred whenever work may exceed Discord's 3-second window.

## Consequences

- (+) No public endpoint, no signature handling; works on a LAN install.
- (+) Rate limits, reconnects and gateway resumes are handled by a maintained library.
- (+) Channel-privacy logic is tested deterministically against the fake.
- (−) The fake can drift from real Discord behaviour. Mitigated by the contract suite (run against the
  adapter manually on a test guild before releases) and spike S3.
- (−) Needs two privileged intents (GuildMembers, MessageContent); fine under 100 guilds, checked at setup.
- (−) A long-lived WebSocket ties Genie to a long-running host (already true by ADR-0001).
