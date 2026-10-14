# ADR-0001: Modular monolith on Nuxt 4, with the Discord bot in the same process

- Status: Accepted (2026-10-13)
- Amended by [ADR-0011](0011-share-infrastructure-through-selfhost-kit.md) (accepted 2026-10-13)
- Date: 2026-10-13

## Context

Genie has two faces: a website where the organizer plans a day and head judges download reports, and a
Discord bot that creates channels and takes `/penalty` commands. Both act on the same data (days, staff,
penalties). There is one developer, one store, a handful of staff and a few hundred rows per day. The
owner already runs [play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web)
on Nuxt 4 + Nitro on Unraid and wants to stay in that ecosystem.

The system needs a long-lived process: the bot holds a gateway WebSocket, and provisioning, export and
purge are background jobs that wait on Discord's rate limits.

## Options considered

1. **One Nuxt 4 app; the bot is a Nitro plugin in the same Node process.** One build, one container, one
   database connection. Website routes and bot handlers call the same module services.
2. **Two deployables: a Nuxt website and a separate bot process sharing SQLite.** Isolates crashes, but
   SQLite across two processes needs care (WAL works, but job leases and in-memory state don't), and the
   Unraid install doubles.
3. **Two deployables talking over HTTP.** Clean separation, but adds an internal API, auth between them and
   two things to keep in step, for no gain at this scale.

## Decision

Option 1. **One Nuxt 4 application** (Nitro `node-server` preset, single Docker container). The bot is
started by `server/plugins/bot.ts`; interaction handlers live in `server/bot/` and are thin, like
`server/api/*`. Domain logic lives in framework-free modules in `server/modules/*`, with ports around
Discord and attendance (ADR-0003, ADR-0008).

Background and scheduled work run in the same process, in a `jobs` module that owns the `job` and
`job_event` tables, the per-day leases and a timer. Due times (purge after the grace period, the retention
sweep) are persisted in `job.due_at`. The timer checks for due work every 60 s, runs each due item exactly
once under the day's lease, and at boot runs anything that fell due while the container was down. Nitro's
scheduled tasks are **not** used: they sit behind `experimental.tasks`, and keeping due times in the DB
makes them survive restarts and lets tests drive them with a fake clock.

Same stack choices as attendance: Nuxt UI, `nuxt-auth-utils`, Drizzle + SQLite, Vitest +
`@nuxt/test-utils`, Playwright, `@nuxt/eslint`.

## Consequences

- (+) One deployable and one language; the website and the bot can't drift apart on rules.
- (+) Jobs, timers and the gateway client need no queue or IPC.
- (+) No dependency on an experimental Nitro feature for the deletes that matter most (purge).
- (+) The launcher, secret bootstrap, entrypoint, CI and release flow are shared with attendance through
  `@towerism/selfhost-kit` (ADR-0011; selfhost-kit ADR-0001).
- (−) A fatal crash takes both faces down together. Mitigated by per-interaction error containment,
  discord.js's own reconnects and Docker's restart policy.
- (−) Single instance only (the gateway session and job leases assume one process). Fine for one store.
- (−) Hot reload in dev restarts the bot; the dev setup uses a separate test application and guild.
