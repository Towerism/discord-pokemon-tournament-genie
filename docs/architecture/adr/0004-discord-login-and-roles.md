# ADR-0004: Website login with Discord OAuth; access from guild roles and day roles

- Status: Proposed
- Date: 2026-10-13

## Context

The website has several users:

- the **organizer**, who configures everything and plans days;
- **head judges**, who need their day's penalties and exports;
- possibly a co-organizer.

Every one of them is already a member of the store's Discord server. Attendance uses a single local
username/password created with a setup code; that suits one organizer, but here head judges change from
day to day.

Secrets the install needs (bot token, OAuth client secret, attendance token) must never go in the Unraid
template (attendance's rule, ADR-0009 here).

## Options considered

1. **Discord OAuth2 (`identify`) via `nuxt-auth-utils`; authorization from the bound guild's roles and
   Genie's day data.**
2. **Local accounts, as attendance.** The organizer would have to create and hand out accounts to head
   judges for each day.
3. **Magic links posted by the bot in DMs.** No OAuth app setup, but a homegrown auth flow to secure.

## Decision

Option 1.

- **First run:** a one-time setup code from the container log unlocks `/setup`. There the organizer
  enters the Discord application's bot token, client ID and client secret. These are stored in the vault
  (AES-256-GCM, key from `NUXT_VAULT_KEY` or `/data/secrets/vault.key`). The first Discord login becomes
  the **install owner**.
- **Who may log in:** members of the bound guild only. Membership and roles are checked through the bot
  (`DiscordGateway.getMember`), not through extra OAuth scopes, and again at each session refresh
  (15 minutes).
- **Permissions:**
  - *Organizer*: the install owner, plus members with the Discord role mapped as organizer in Settings.
    Everything.
  - *Head judge of a day*: an event's `headjudge` staffer, or a member with the mapped head-judge role
    who is on that day's staff. Only that day's penalties, exports, Sync and Close.
  - Everyone else: no website access. Their Genie is Discord.
- Sealed session cookies, the JSON-only CSRF guard, rate limits and security headers are as in attendance.

## Consequences

- (+) No passwords to manage; access follows the server the store already runs.
- (+) Removing someone from the guild or role removes their access within one session refresh.
- (−) The OAuth redirect must be a URL Discord accepts and the browser can reach; spike S1 settles LAN,
  Tailscale and reverse-proxy setups.
- (−) Discord down means no website login. Acceptable: the bot is down too, and exports were already written.
