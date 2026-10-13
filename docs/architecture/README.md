# Tournament Genie — System Architecture

Status: **Proposed** (awaiting the owner's review) · Date: 2026-10-13 · Author: Martin Fracker, Jr.

## 1. Context

A store runs a **day of Play! Pokémon events**, often several tournaments at once (a TCG League
Challenge, a VGC event and a GO event, say), staffed by a group of judges who all share one Discord
server. During the day, staff coordinate in Discord, and it helps to have channels set up just for
that day: somewhere for all the staff, and for each event a floor channel and a channel for penalties.

Doing that by hand hurts:

1. **Setting up is tedious.** Creating a category and 5–10 channels, then making sure only the selected
   staff can see them, means editing permissions channel by channel. Mistakes leak the channels to
   players or lock a judge out.
2. **Reusing old channels is bad.** Last month's channels carry last month's history and members.
   Every event day should get fresh channels that are gone once the day is over.
3. **Penalties are free text.** Judges post penalties in a channel however they like. At the end of the
   day the head judge reads the channel back and types a CSV report by hand.
4. **Staffing is entered twice.** The organizer already assigns staff to each tournament in
   [play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web) ("attendance"),
   then has to pick the same people again in Discord.

Tournament Genie ("Genie") is a **Discord bot plus a website** that removes this toil. It is entirely
self-contained: it never talks to play-tools or any `*.pokemon.com` service. Its only outside
integrations are Discord and, optionally, attendance.

## 2. Goals and non-goals

### Goals (v1)

- **G1 Event day plan.** On the website, the organizer plans a day: its date, its events (name, game,
  start time) and its staff (who, which events, which role). Templates make a typical day a few clicks.
- **G2 Import from attendance.** The day's tournaments and their assigned staff can be pulled from
  attendance instead of typed in ([ADR-0008](adr/0008-attendance-integration.md)). Staff are matched to
  Discord members by their Play! Pokémon player ID.
- **G3 One-click channels.** "Open the day" creates a fresh Discord category and channels from a
  **blueprint**, visible only to the day's staff (plus the bot and the organizer), and keeps them in step
  as staff or events change during the day ([ADR-0005](adr/0005-channels-as-desired-state.md)).
- **G4 Structured penalties.** Judges record penalties with `/penalty` in Discord. The bot posts a card
  in the event's penalty channel and stores the penalty as data. Head judges can edit or void it
  ([ADR-0006](adr/0006-structured-penalties.md)).
- **G5 Penalty report.** The head judge downloads each event's penalties as a CSV in the format they
  submit (§6.6), with no copying out of the channel.
- **G6 Close out and clean up.** "Close the day" locks the channels, exports the penalty CSVs and a
  transcript of every channel to the website, then deletes the channels after a grace period
  ([ADR-0007](adr/0007-close-out-export-then-delete.md)).

### Non-goals (v1)

- Talking to play-tools, TOM or any Pokémon service. Pairings, results and staff points stay in
  attendance and play-tools.
- Running more than one Discord server per install. One store, one guild (§5.1). The data model keys on
  the guild so a later multi-guild version is possible.
- Free-text penalty scraping. Penalties are recorded through `/penalty`; ordinary messages in a penalty
  channel are discussion and go only into the transcript.
- Player-facing features. Players never see Genie's channels.
- Reusing or archiving channels across days.

### Quality attributes (ranked)

1. **Channel privacy.** No one outside the day's staff (plus the organizer and the bot) may ever see a
   day channel. A permission mistake leaks penalty discussions about named, often minor, players.
2. **No lost penalties.** Every recorded penalty reaches the CSV exactly as last edited, and nothing is
   deleted before it has been exported.
3. **Low operator effort.** Opening a typical day is ≤ 3 clicks once its staff are in place. Recording a
   penalty takes one command and one short form.
4. **Cheap and painless to run on Unraid.** One container, one appdata folder, no required template
   fields, credentials entered in the browser (same rules as attendance, [ADR-0009](adr/0009-docker-on-unraid.md)).
5. **Resilience to outside change.** Discord and attendance each sit behind one port; changes stay
   contained in one adapter.

## 3. Architecture at a glance

**Pattern:** a modular monolith with a hexagonal (ports and adapters) boundary around Discord and
attendance. It is **one Nuxt 4 application**, the same stack as attendance, and the Discord bot runs
**inside the same Node process**, started by a Nitro plugin ([ADR-0001](adr/0001-modular-monolith-nuxt-with-bot.md)).
The bot receives slash commands over Discord's **gateway WebSocket**, so the install needs no public
HTTPS endpoint ([ADR-0003](adr/0003-discord-gateway-and-port.md)).

```mermaid
flowchart LR
  subgraph Browser
    SPA["Nuxt app (Vue 3)<br/>Nuxt UI"]
  end
  subgraph DiscordClients["Discord clients"]
    J["Judges / head judges<br/>/penalty, buttons, modals"]
  end

  subgraph Server["Node.js process (Nitro node-server)"]
    API["Nitro routes<br/>server/api/*"]
    BOT["Bot plugin<br/>discord.js gateway client<br/>interaction router"]
    subgraph Modules
      SETUP["setup<br/>(install, guild binding, vault)"]
      DIR["directory<br/>(staff ↔ Discord user ↔ player ID)"]
      DAYS["event-days<br/>(days, events, staff, blueprints)"]
      PROV["provisioning<br/>(plan → apply → reconcile jobs)"]
      PEN["penalties<br/>(records, catalog, CSV)"]
      CLOSE["closeout<br/>(lock, transcripts, exports, delete)"]
      IMP["attendance-import<br/>(day snapshot)"]
    end
    JOBS["Job runner (Nitro plugin)<br/>+ scheduled tasks"]
    subgraph Ports
      DG[["DiscordGateway"]]
      AS[["AttendanceSource"]]
    end
    subgraph Adapters
      DJS["DiscordJsAdapter"]
      AHTTP["AttendanceHttpAdapter"]
    end
  end

  DB[("SQLite (WAL)<br/>Drizzle")]
  FS[("/data/exports<br/>CSV + transcripts")]
  DISCORD["Discord API<br/>gateway + REST"]
  ATT["attendance<br/>GET /api/integrations/v1/days/{date}"]

  SPA -- "JSON, session cookie" --> API
  J --> DISCORD
  DISCORD <--> DJS
  BOT --> Modules
  API --> Modules
  PROV --> JOBS
  CLOSE --> JOBS
  PROV --> DG
  CLOSE --> DG
  PEN --> DG
  DIR --> DG
  IMP --> AS --> AHTTP --> ATT
  DG --> DJS
  Modules --> DB
  CLOSE --> FS
```

### Tech stack

Deliberately the same as attendance, so one person can work on both and reuse what attendance proved
(secret bootstrap, launcher, Unraid template, CI, release flow).

| Layer         | Choice                                                                    | Why |
| ------------- | ------------------------------------------------------------------------- | --- |
| Language      | TypeScript everywhere                                                     | One language; Zod schemas shared through `shared/`. |
| Framework     | **Nuxt 4** (Vue 3, Vite, Nitro `node-server`)                             | One build, one origin, one long-lived process for the bot, jobs and timers. |
| Discord       | **discord.js v14** (gateway + REST, built-in rate-limit queue)            | The most used and maintained Node library; handles sharding-free single-guild bots, rate-limit buckets and reconnects. Hidden behind `DiscordGateway`. |
| UI            | Nuxt UI + `@nuxt/icon`                                                    | Tables, forms, modals and toasts out of the box. |
| App auth      | `nuxt-auth-utils` with its **Discord OAuth** provider                     | Staff already have Discord accounts; access follows guild roles ([ADR-0004](adr/0004-discord-login-and-roles.md)). |
| Database      | SQLite (WAL) + Drizzle ORM + drizzle-kit migrations, `better-sqlite3`    | Hundreds of rows per day. Zero ops ([ADR-0002](adr/0002-sqlite-drizzle.md)). |
| Files         | `/data/exports/<day>/` for CSVs and transcripts                           | Big blobs stay out of the DB; one folder to back up. |
| Crypto        | Node `crypto` AES-256-GCM vault for the bot token, OAuth secret and attendance token | Same pattern as attendance's token vault. |
| Packaging     | Single `linux/amd64` image on GHCR, Unraid template                      | [ADR-0009](adr/0009-docker-on-unraid.md). |
| Testing       | Vitest + `@nuxt/test-utils`; an in-memory **fake Discord** behind `DiscordGateway`; an in-process HTTP fake of attendance; Playwright for website journeys | No real Discord or attendance calls in tests. |
| Quality       | `@nuxt/eslint` (incl. module-boundary rules), `vue-tsc` in CI            | |

### Repository layout

```
app/                          Vue side
  pages/
    index.vue                 Days: upcoming and recent event days
    days/[id]/index.vue       Day plan: events, staff, channel preview, Open / Sync / Close
    days/[id]/penalties.vue   Penalties per event, edit/void, CSV download
    days/[id]/exports.vue     Transcripts and CSVs of a closed day
    staff.vue                 Staff directory (Discord user ↔ player ID)
    blueprints.vue            Channel blueprints and day templates
    settings.vue              Guild, roles, attendance connection, retention, catalog
    setup.vue  login.vue
server/
  api/                        thin Nitro routes (§7)
  bot/                        interaction router: slash commands, buttons, modals → module services
  modules/                    plain TS, no h3 / Nuxt / discord.js imports
    setup/  directory/  event-days/  provisioning/  penalties/  closeout/  attendance-import/
    discord/{port.ts, adapters/discordjs/, fake/}
    attendance/{port.ts, adapters/http/}
    vault/
  plugins/                    bot.ts (log in, register commands), jobs.ts (runner, boot recovery)
  tasks/                      closeout:purge (delete channels after grace), retention:sweep
  db/                         schema, migrations, client
shared/
  schemas/                    Zod DTOs
  penalties/                  catalog types, CSV writer (pure)
  blueprints/                 blueprint → desired channel set (pure)
  time/                       store-timezone date helpers
docs/architecture/            this document + ADRs
deploy/unraid/                template + icon
```

Module rules (enforced by ESLint):

- `server/api/*` and `server/bot/*` are thin: authorize, validate with shared Zod schemas, call a module
  service, map errors. The bot router is the Discord-side twin of the API routes.
- `server/modules/*` are plain TS: no h3, Nuxt or discord.js imports.
- Only `server/modules/discord/adapters/*` imports discord.js. Only `server/modules/attendance/adapters/*`
  calls attendance. Their payload shapes never cross the ports.
- Modules talk through each other's exported services, never each other's tables.
- Discord IDs (snowflakes) are TEXT everywhere; `player_id` is TEXT everywhere.

## 4. Integrations

### 4.1 Discord

**One bot application per install**, created by the organizer in the Discord Developer Portal and
invited to the store's server. The setup wizard walks through it (§6.1).

- **Token handling.** The bot token and the OAuth client secret are pasted into the setup wizard and
  stored in the vault (AES-256-GCM, key from `NUXT_VAULT_KEY` or `/data/secrets/vault.key`). Never in
  the Unraid template, never logged, never returned to the browser.
- **Intents.** `Guilds`, `GuildMembers` (privileged: the staff picker and resolving members), and
  `MessageContent` (privileged: transcripts of human messages). Both privileged intents are a toggle in
  the portal for a bot in fewer than 100 servers; the wizard checks them.
- **Permissions** (the invite URL requests exactly these): View Channels, Manage Channels, Manage Roles
  (needed to write permission overwrites), Send Messages, Embed Links, Attach Files, Read Message
  History, Use Application Commands. Not Administrator.
- **Interactions over the gateway** ([ADR-0003](adr/0003-discord-gateway-and-port.md)). Slash commands,
  buttons, selects and modals arrive on the bot's WebSocket. No interactions endpoint URL, so no
  public HTTPS and no request signing to verify.
- **Commands are guild-scoped**, registered on boot to the bound guild, so changes apply instantly.
- **Rate limits.** discord.js queues REST calls per route bucket. Provisioning and teardown are jobs that
  await each call in turn and checkpoint after each (§6.3), so a 429 slows them, never duplicates work.

`DiscordGateway` (the port, in `server/modules/discord/port.ts`) is the only way modules reach Discord:

```ts
interface DiscordGateway {
  // guild + members
  getGuild(): Promise<GuildInfo>;                         // name, bot's highest role position, missing permissions
  listMembers(query?: string): Promise<Member[]>;
  getMember(userId: Snowflake): Promise<Member | null>;
  // channels
  createCategory(spec: CategorySpec): Promise<Snowflake>;
  createChannel(spec: ChannelSpec): Promise<Snowflake>;   // text or voice, parent, topic, overwrites
  updateChannel(id: Snowflake, patch: ChannelPatch): Promise<void>;
  setOverwrites(id: Snowflake, overwrites: Overwrite[]): Promise<void>; // full replace, idempotent
  deleteChannel(id: Snowflake, reason: string): Promise<'deleted' | 'already_gone'>;
  getChannel(id: Snowflake): Promise<ChannelState | null>;
  // messages
  postMessage(channelId: Snowflake, msg: OutboundMessage): Promise<Snowflake>;
  editMessage(channelId: Snowflake, messageId: Snowflake, msg: OutboundMessage): Promise<void>;
  readHistory(channelId: Snowflake, before?: Snowflake): Promise<HistoryPage>; // 100 per page, oldest-last
}
```

Inbound interactions go the other way: the discord.js adapter turns each one into a plain
`InboundInteraction` (command name, options, user, channel, guild) for `server/bot/`, which replies
through a small `InteractionReply` interface. The fake gateway in tests implements both sides in memory,
including a permission model, so privacy tests (§11) can ask "can user X see channel Y?".

### 4.2 Attendance (play-pokemon-attendance-web)

See [ADR-0008](adr/0008-attendance-integration.md). In short:

- **Pull, read-only, on demand.** Genie calls one new attendance endpoint,
  `GET /api/integrations/v1/days/{date}`, with a bearer token minted in attendance's Settings. Attendance
  answers with that date's tournaments and the staff assigned to each:

  ```json
  {
    "date": "2026-10-18",
    "timezone": "America/Chicago",
    "tournaments": [
      {
        "id": "8f6c…-guid",
        "name": "October League Challenge",
        "displayId": "25-10-000123",
        "startsAt": "2026-10-18T16:00:00Z",
        "game": "tcg",
        "staff": [
          { "playerId": "1234567", "name": "Ash K.", "role": "headjudge" },
          { "playerId": "7654321", "name": "Misty W.", "role": "judge" }
        ]
      }
    ],
    "unread": []
  }
  ```

  `game` is attendance's product for the tournament when known, otherwise `null`; `unread` names
  professors attendance couldn't read (its ADR-0009). Staff come from attendance's desired assignments
  (`staff_assignment`, live rows), so staff the organizer picked but hasn't applied in play-tools yet
  still come across.
- **A snapshot, not a live link.** Importing copies the data into Genie's day plan, marked
  `source = attendance` with the upstream ids. The organizer can edit freely afterwards. **Refresh from
  attendance** re-pulls and shows a diff (added / removed / role changed) to accept, never a silent overwrite.
- **Attendance being down never blocks Genie.** Every imported field can also be entered by hand.
- **Player ID → Discord user** is Genie's job (§5.3). Imported staff without a linked Discord member show
  as "not linked" and are not given channel access until linked.
- **Companion change in attendance.** The endpoint, its token and its ADR live in the attendance repo and
  need their own issue and spec there. Genie's adapter is built against a recorded contract fixture and
  an in-process fake, so the two can be built in parallel.

## 5. Domain model and data

### 5.1 Tenancy

One install serves **one guild** (`guild_binding`, a single row set during setup) in one **store
timezone** (`TZ`, as in attendance). Every table that holds Discord state carries the `guild_id` so a
future multi-guild version is a migration, not a redesign.

### 5.2 Entities

```mermaid
erDiagram
  GUILD_BINDING ||--o{ EVENT_DAY : hosts
  EVENT_DAY ||--o{ EVENT : has
  EVENT_DAY ||--o{ DAY_STAFF : staffed_by
  DAY_STAFF ||--o{ EVENT_STAFF : works
  EVENT ||--o{ EVENT_STAFF : has
  STAFF_MEMBER ||--o{ DAY_STAFF : is
  BLUEPRINT ||--o{ BLUEPRINT_CHANNEL : defines
  EVENT_DAY }o--|| BLUEPRINT : uses
  EVENT_DAY ||--o{ PROVISIONED_CHANNEL : owns
  EVENT ||--o{ PROVISIONED_CHANNEL : "per-event channels"
  EVENT ||--o{ PENALTY : records
  PENALTY ||--o{ PENALTY_REVISION : history
  EVENT_DAY ||--o{ JOB : runs
  JOB ||--o{ JOB_EVENT : logs
  EVENT_DAY ||--o{ EXPORT_FILE : produces
  PENALTY_CATEGORY ||--o{ PENALTY : classifies
  PENALTY_TYPE ||--o{ PENALTY : "penalty given"
```

| Table | Key columns | Notes |
| ----- | ----------- | ----- |
| `guild_binding` | `guild_id`, `name`, `organizer_role_id`, `head_judge_role_id`, `staff_role_id?` | Single row. Roles map Discord roles to Genie permissions (§9). |
| `staff_member` | `id`, `discord_user_id?` (unique), `player_id?` (unique), `display_name`, `link_state` (`linked`/`claimed`/`unlinked`) | The directory: one person, at most one Discord account and one player ID. A judge needs a player ID to record penalties (it is the CSV's *Judge Player ID*). |
| `blueprint`, `blueprint_channel` | channel `key`, `scope` (`day`/`per_event`), `kind` (`text`/`voice`), `name_pattern` (e.g. `{event}-penalties`), `audience` (`all_staff`/`event_staff`/`head_judges`), `purpose` (`general`/`floor`/`penalties`), `topic`, `position` | Pure data; `shared/blueprints` turns it into the desired channel set. A default blueprint is seeded (§6.2). |
| `event_day` | `id`, `date` (store-TZ `YYYY-MM-DD`), `title`, `blueprint_id`, `state` (`draft`/`open`/`closing`/`closed`/`purged`), `category_id?`, `grace_until?`, `source` | Never reuses a category: each day owns its own. |
| `event` | `id`, `day_id`, `name`, `slug`, `game` (`tcg`/`vgc`/`go`/`other`), `starts_at`, `attendance_tournament_id?`, `tournament_id?` | `slug` is unique within the day and drives channel names. `tournament_id` is the play-tools display ID (`25-12-001050`), the CSV's *Tournament ID*: imported from attendance or typed in, and required before the event's CSV can be exported. |
| `day_staff` | `day_id`, `staff_member_id`, `is_day_lead` | Who has access to the day's channels at all. |
| `event_staff` | `event_id`, `staff_member_id`, `role` (`headjudge`/`judge`/`scorekeeper`/`administration`/`translator`) | Same role codes as play-tools/attendance. Head judges of an event can edit/void its penalties. |
| `provisioned_channel` | `day_id`, `event_id?`, `blueprint_channel_key`, `discord_channel_id`, `applied_overwrites_hash`, `state` (`present`/`missing`/`deleted`) | The **only** record of which Discord channels Genie owns. Written immediately after each create. |
| `job`, `job_event` | `kind` (`provision`/`sync`/`lock`/`export`/`purge`/`attendance_import`), `state`, `day_id`, step log | Same rails as attendance's submission jobs: lease per day, event log, boot recovery, retry. |
| `penalty_category`, `penalty_type` | `id`, `label` (e.g. `Game Play`, `GL`), `games`, `rank`, `active`, `season` | The catalog, as data: seeded from the judges' clipboard penalty sheet (2024-05, §6.7), editable in Settings. The CSV writes `label` as is. A guideline change is an edit, not a release. |
| `penalty` | `id`, `event_id`, `round` (≥ 1; top-cut rounds keep counting, as in the sample), `competitor_player_id`, `category_id`, `severity` (`Minor`/`Major`/`Severe`), `penalty_type_id`, `notes`, `judge_staff_id`, `judge_player_id` (copied at recording), `recorded_at`, `state` (`active`/`voided`), `void_reason?`, `discord_message_id`, `revision` | Structured, one row per CSV line. **No competitor name**: the report doesn't need one, so Genie never collects it. The Discord card is a view of this row, never the source. |
| `penalty_revision` | `penalty_id`, `revision`, full row snapshot, `edited_by`, `edited_at` | Edits and voids are auditable. |
| `export_file` | `day_id`, `kind` (`penalties_csv`/`transcript_json`/`transcript_html`/`attachments`), `event_id?`, `path`, `sha256`, `bytes`, `created_at` | Files live in `/data/exports/<day-id>/`. |
| `app_session` | via `nuxt-auth-utils` sealed cookie | No session table needed. |

### 5.3 Linking a person to Discord and to a player ID

The directory row ties three identities together: a **Discord user** (who gets channel access and who
runs commands), a **player ID** (how attendance identifies staff) and a **display name**.

- **Organizer links** on the Staff page with a guild-member picker: authoritative, `linked`.
- **Self-claim:** a judge runs `/link player-id:1234567` in Discord. That creates a `claimed` link the
  organizer confirms with one click. A claim never grants channel access on its own, because a wrong or
  malicious claim would put someone else's assignment in front of the claimant.
- A Discord member who leaves the guild keeps their row; their overwrites simply stop mattering.
- Names imported from attendance only seed a new row's display name and never overwrite one (attendance
  avoids showing dead names for the same reason, its ADR-0007 decision 13).

## 6. Core flows

### 6.1 First run

1. The container prints a one-time **setup code** to its log (as attendance does).
2. `/setup` asks for the code, then walks the organizer through: create a Discord application, paste the
   **bot token**, **client ID** and **client secret**, toggle the two privileged intents, and invite the
   bot with the generated URL. Genie verifies each step live (token valid, bot in exactly one guild,
   intents on, permissions present, bot role high enough).
3. The organizer **logs in with Discord** for the first time; that account becomes the install owner.
   They map Discord roles to Genie's *organizer* and *head judge* permissions (§9).
4. Optional: paste attendance's base URL and integration token; Genie checks it with a test call.

### 6.2 Plan a day

The default blueprint (editable, more can be saved):

| Scope | Channel | Audience | Purpose |
| ----- | ------- | -------- | ------- |
| category | `🏆 {weekday} {date} · {title}` | everyone on the day | — |
| day | `#day-staff` | all staff | general |
| day | `#head-judges` | head judges + organizer | general |
| per event | `#{slug}-floor` | event staff | floor |
| per event | `#{slug}-penalties` | event staff | penalties |

**Rule:** every per-event channel is visible only to that event's staff (plus the organizer role and
the bot). Blueprints can't widen a per-event channel's audience; day-wide channels are for all of the
day's staff or its head judges.

The organizer creates a day (date, title, blueprint), then either **imports from attendance** or adds
events and staff by hand. A **day template** can pre-fill typical events (e.g. "Saturday: TCG LC + VGC").
The page shows a live **preview** of the exact channels and who can see each, computed by the same pure
function that provisioning uses.

### 6.3 Open the day (provisioning)

[ADR-0005](adr/0005-channels-as-desired-state.md). The day plan is **desired state**; a job makes
Discord match it.

```mermaid
sequenceDiagram
  autonumber
  actor O as Organizer
  participant W as Website
  participant P as provisioning
  participant J as Job (kind = provision)
  participant D as DiscordGateway

  O->>W: Open the day
  W->>P: POST /api/days/{id}/open
  P->>P: validate: every day staffer linked, slugs unique, bot permissions ok
  P-->>W: 202 {jobId}
  J->>J: desired = blueprint × events × staff (pure)
  J->>D: createCategory (deny @everyone View, allow bot, allow organizer role)
  J->>J: record category_id
  loop each desired channel, in blueprint order
    J->>D: createChannel with full overwrites
    J->>J: record provisioned_channel (before the next call)
  end
  J->>D: getChannel each → reconcile overwrites
  J->>D: post a pinned "how to use this day" message in #day-staff
  J-->>W: progress (SSE): 9 channels, 14 staff
```

- **Overwrites are computed, not edited.** For each channel: `@everyone` deny View; the bot allow
  View/Send/Manage; the organizer role allow View; one **member overwrite per staffer** in the channel's
  audience, allowing View/Send/Read History/Attach. `setOverwrites` replaces the whole list, so applying
  twice is a no-op, and anything a human changed by hand is put back on the next sync.
- **Crash safety.** A channel's ID is stored as soon as Discord returns it. On retry the job adopts it
  instead of creating a second one. A create that Discord applied but whose answer was lost leaves an
  orphan; the reconcile step finds channels in the category Genie didn't record and lists them for the
  organizer to delete or adopt.
- **Mid-day changes.** Adding or removing a staffer or an event, or a role change, marks the day
  out of sync; **Sync** (website, or a button in `#head-judges`) runs the same job, which only applies
  the difference. Removing a staffer removes their overwrites immediately.
- **Drift.** A channel deleted by hand is marked `missing` and recreated on the next sync (a new channel,
  never someone else's).

### 6.4 Record a penalty

[ADR-0006](adr/0006-structured-penalties.md).

```mermaid
sequenceDiagram
  autonumber
  actor Jd as Judge
  participant D as Discord
  participant B as Bot router
  participant P as penalties
  Jd->>D: /penalty in #lc-penalties (round, category, severity, penalty: autocomplete)
  D->>B: interaction
  B->>B: caller is staff on this event with a player ID? penalties channel of an open day?
  B-->>D: modal: competitor's player ID, notes
  Jd->>D: submit
  D->>B: modal submit
  B->>P: record(eventId, judge, fields)
  P->>P: validate (catalog, player ID format), insert penalty + revision 1
  P->>D: post card (embed) with Edit / Void buttons
  P->>P: store discord_message_id
  B-->>D: ephemeral "Recorded #12"
```

- **Event from the channel.** Run in an event's penalty channel, the event is implied. Run in a day-wide
  channel, the command asks for the event (autocomplete over the day's events).
- **Options mirror the clipboard sheet.** `round` (integer), `category` (Game Play, Deck/Team, Pace of
  Play, Procedural, Unsporting, Cheating), `severity` (Minor / Major / Severe) and `penalty` (Warning,
  DPC, QPC, GL, DQ, limited to those valid for the event's game: no prize penalties outside TCG). The modal
  takes only the free-text fields: the competitor's player ID (validated as digits) and the notes. The
  judge's player ID comes from the directory, so a judge without one is told to `/link` first.
- **Edit / Void** buttons on the card: the recording judge can edit within 15 minutes; the event's head
  judges and the organizer can edit or void any time until the day is closed. Every change is a new
  `penalty_revision`, and the card is edited in place to show the current state ("Voided by …").
- **The card is a view.** If someone deletes the bot's card, the penalty still exists; the website shows
  it and "Repost card" restores it.
- **Website parity.** Head judges can also view, edit and void penalties on the Penalties page, and add
  one there if Discord is down.

### 6.5 Close the day

[ADR-0007](adr/0007-close-out-export-then-delete.md).

1. A head judge or the organizer clicks **Close the day** (website, or the button in `#head-judges`).
   Genie asks for confirmation and lists any penalty still being edited.
2. **Lock:** a `lock` job rewrites every channel's overwrites to View + Read History only (no Send).
   Penalties become read-only.
3. **Export:** an `export` job writes, per event, the **penalty CSV** (§6.6), and for every channel a
   **transcript** (JSON, the source of truth, plus a readable HTML page), with attachments downloaded
   up to a size cap. Each file is recorded with its SHA-256.
4. **Grace period:** the day is `closed`; channels stay locked and visible to the staff for
   `GENIE_PURGE_GRACE` (default 7 days) so anyone can still look something up. "Delete now" skips it.
5. **Purge:** the scheduled `closeout:purge` task deletes the day's channels and category, **but only if
   the export job succeeded and every exported file's hash still matches**. Otherwise it refuses and
   alerts the organizer. The day becomes `purged`.

Exports stay downloadable on the website for the retention period (§15 Q3).

### 6.6 Penalty CSV

The format is the one the head judge submits today (sample provided by the owner, 2026-10-13). It is the
**contract**: a golden-file test built from that sample guards it.

```
Tournament ID,Round of Issue,Judge Player ID,Competitor's Player ID,Category,Severity,Penalty,Notes
25-12-001050,1,XXXXXX,XXXXXXX,Gameplay Error,Minor,Warning,Played Buddy-Buddy Poffin and did not get out a Pokémon …
25-12-001050,6,XXXXXX,XXXXXXX,Deck Legality,Major,Game Loss,"Marked cards with pattern. … Game Loss issued for Round 1 of Top Cut."
```

| Column | Source |
| ------ | ------ |
| Tournament ID | `event.tournament_id` (play-tools display ID) |
| Round of Issue | `penalty.round` |
| Judge Player ID | `penalty.judge_player_id` (the recording judge, as of recording) |
| Competitor's Player ID | `penalty.competitor_player_id`, written as text so leading zeros survive |
| Category | `penalty_category.label` |
| Severity | `Minor` / `Major` / `Severe` |
| Penalty | `penalty_type.label` |
| Notes | `penalty.notes` |

Rules:

- **One file per event** (every row has the same Tournament ID), ordered by round, then recording time.
- **Voided penalties are left out**, and listed in a separate `…-voided.csv` for the record.
- **Quoting as the sample:** RFC 4180, a field quoted only when it holds a comma, quote or line break.
  UTF-8, no BOM, Unix (LF) line endings, header row exactly as above.
- **Labels are for people.** The report is read by a human, so Category, Severity and Penalty are
  written with the same labels judges pick (the clipboard sheet's). The contract is the columns, their
  order and the quoting, not the label wording.
- **No cell rewriting.** The file is a submission artifact, so Genie does not prefix formula-like cells
  (`=`, `+`, `-`, `@`) the way a spreadsheet export would. The website warns the head judge not to round-trip
  the file through Excel, which also strips leading zeros from player IDs.
- **Export is refused** while an event has no Tournament ID or a penalty is missing a required field;
  the page lists what to fix.

### 6.7 Penalty catalog seed

Judges already fill in the **clipboard penalty sheet** (2024-05); its checkboxes seed the catalog and are
the options `/penalty` offers.

| Kind | Labels | Games |
| ---- | ------ | ----- |
| Category | Game Play, Deck/Team, Pace of Play, Procedural, Unsporting, Cheating | all |
| Severity | Minor, Major, Severe | all |
| Penalty | Warning, GL, DQ | all |
| Penalty | DPC, QPC | TCG only |

The sheet also has **Player's Name** and **Group** (JR / SR / MA age division). Genie doesn't collect
either: the CSV doesn't need them, and it keeps minors' data to a minimum.

## 7. HTTP API (Nitro routes)

All routes need a session; the role check per route is in the table. Bodies are JSON and validated with
shared Zod schemas. Errors carry `data.code`.

| Method + path | Who | Purpose |
| ------------- | --- | ------- |
| `GET /api/setup`, `POST /api/setup/*` | setup code | First-run wizard steps (§6.1) |
| `GET /auth/discord` | anyone | Discord OAuth login (`nuxt-auth-utils`) |
| `GET /api/days`, `POST /api/days` | organizer | List / create event days |
| `GET/PATCH/DELETE /api/days/{id}` | organizer (read: day's head judges) | Day plan; delete only a `draft` |
| `POST/PATCH/DELETE /api/days/{id}/events[/{eventId}]` | organizer | Events |
| `PUT /api/days/{id}/staff` | organizer | Day and event staff (full replace, returns the diff) |
| `GET /api/days/{id}/preview` | organizer, head judges | Desired channels and audiences |
| `POST /api/days/{id}/import` | organizer | Pull or refresh from attendance; returns a diff to accept |
| `POST /api/days/{id}/import/accept` | organizer | Apply an import diff |
| `POST /api/days/{id}/open`, `/sync`, `/close`, `/purge` | organizer; `close` also head judges | Start jobs (202 + job id) |
| `GET /api/jobs/{id}`, `GET /api/jobs/{id}/events` (SSE) | as the day | Progress |
| `GET /api/days/{id}/penalties`, `POST`, `PATCH /{pid}`, `POST /{pid}/void`, `POST /{pid}/repost` | head judges of the event, organizer | Penalties |
| `GET /api/days/{id}/exports`, `GET /api/exports/{fileId}` | head judges of the day, organizer | Download CSVs and transcripts (`no-store`, audited) |
| `GET/POST/PATCH /api/staff[/{id}]`, `POST /api/staff/{id}/confirm-claim` | organizer | Directory |
| `GET /api/discord/members?q=` | organizer | Member picker |
| `GET/PUT /api/blueprints…`, `GET/PUT /api/catalog…`, `GET/PUT /api/settings` | organizer | Configuration |

## 8. Discord surface

| Command / component | Who | Where | What |
| ------------------- | --- | ----- | ---- |
| `/penalty` | event staff | penalty channel (or any day channel, with `event:`) | Record a penalty (§6.4) |
| `/penalties` | event staff | day channels | Ephemeral list of the event's penalties so far |
| `/link player-id:` | any guild member | anywhere | Claim a player ID (§5.3) |
| `/day status` | day staff | day channels | Ephemeral: events, staff, sync state |
| Card buttons **Edit**, **Void** | see §6.4 | penalty card | Modal edit / void with reason |
| Pinned panel **Sync**, **Close the day** | head judges, organizer | `#head-judges` | Same as the website buttons |

Every interaction is authorized on the server from Genie's own data (day staff, event roles, guild
roles), never from Discord's command permission settings alone.

## 9. Security and privacy

| Threat | Control |
| ------ | ------- |
| A day channel visible to the wrong people | `@everyone` denied at the category **and** every channel (no reliance on sync with the category). Overwrites are computed from data and replaced whole. After every provision/sync the job re-reads each channel and checks that the effective audience equals the desired one; a mismatch fails the job loudly. The privacy rule is the most heavily tested behaviour (§11). |
| Bot token theft (acts as the bot in the guild) | Vault (AES-256-GCM, key from env or `/data/secrets/vault.key`, 0600, never in the DB). Never logged or sent to the browser. Least-privilege permissions, no Administrator. Rotating it is one paste in Settings. |
| Unauthorized website use | Discord OAuth login; access requires membership in the bound guild **and** the organizer role, or being a head judge on a day (only that day's pages). Sealed httpOnly SameSite=Lax cookies; JSON-only middleware for CSRF; rate-limited login; security headers as attendance (§9 there). |
| Spoofed or replayed interactions | Gateway delivery only (no public endpoint). Every handler re-checks the caller against Genie's data. |
| Attendance token theft | Stored in the vault; read-only scope on attendance's side; revocable there. |
| Minors' data in penalties and transcripts | Penalties hold the competitor's player ID and the penalty facts, **no name**. Transcripts hold whatever staff typed. Exports are served `no-store`, downloads are audited, and a retention sweep deletes transcripts and penalty data after a configurable period (90 days for transcripts, 1 year for penalties). Logs redact message content, notes, tokens and secrets. |
| CSV opened in a spreadsheet (formula injection, lost leading zeros) | The file is a submission artifact and is written verbatim (§6.6); the download page warns against editing it in Excel. Notes are entered only by authenticated staff. |
| Losing penalties to an early delete | Purge requires a successful export with matching hashes; deletion is a separate, logged job. |
| Supply chain | Lockfile, Renovate, `pnpm audit` in CI (as attendance). |

**Permission levels:** *organizer* (Discord role mapped in Settings, plus the install owner): everything.
*Head judge* of a day (an event's `headjudge` staff, or the mapped head-judge role while on the day's
staff): that day's penalties, exports, Sync and Close. *Staff*: Discord commands only.

## 10. Deployment and operations

- **One container on Unraid**, beside attendance ([ADR-0009](adr/0009-docker-on-unraid.md)): default port
  3001, `/data` appdata (`app.db`, `secrets/`, `exports/`), PUID/PGID 99/100, `TZ`, no required
  template fields. Same launcher, secret bootstrap, entrypoint and CI/release flow as attendance.
- **Reaching attendance:** by URL (e.g. `http://<unraid-ip>:3000` or a shared Docker network name),
  entered in Settings.
- **Discord login redirect:** `NUXT_PUBLIC_SITE_URL` + `/auth/discord`, registered in the Discord
  application (spike S1 confirms which URLs Discord accepts).
- **Bot lifecycle:** the bot plugin logs in at boot and logs out on shutdown; jobs left running are marked
  `interrupted` at boot and can be retried. The site shows bot status (connected, latency, missing
  permissions) on every page header.
- **Backups:** Appdata Backup of the folder (optional Litestream, as attendance). Restore `secrets/` with
  `app.db`.
- **Logs:** structured, with an exact redaction key list (token, secret, authorization, cookie, content,
  notes) as in attendance.

## 11. Testing strategy (outline)

Each issue's spec carries its own test plan; these are the high-value areas the plans must cover.

- **Channel privacy (highest risk).** The fake `DiscordGateway` models overwrites and computes effective
  View permission. Tests assert, for every blueprint audience and every mid-day change, that the set of
  users able to see each channel equals the desired set: nobody extra, nobody missing. Property-based
  tests over random days (events × staff × roles) against the pure `desiredChannels()` function.
- **Provisioning job.** Crash after each step and retry: no duplicate channels; adopted IDs; drift
  (deleted channel, edited overwrite, foreign channel in the category); 429 and 5xx from the fake.
- **Penalties.** Authorization per role and channel; judge without a player ID; catalog validation; edit
  window; revisions; card repost; the CSV writer against a golden file built from the owner's sample
  (quoting of commas and quotes in notes, `DPC` labels, leading zeros, voided rows excluded).
- **Close-out.** Lock before export; export failure blocks purge; hash mismatch blocks purge; grace timer
  driven by a fake clock.
- **Attendance adapter.** Contract tests against a recorded fixture of the attendance endpoint; diff of a
  refresh; attendance down.
- **API routes.** Auth and role on every route, validation, status codes, error mapping.
- **E2E (Playwright).** Only the critical journeys: first-run setup against a fake Discord; plan → open
  → close a day.
- **Manual smoke** on a real test guild before each release (Discord has no sandbox): a checklist, not a test suite.

## 12. Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Permission mistake exposes a channel | §9 control + §11 privacy tests + post-apply audit |
| Bot role below a staffer's role can't manage overwrites in some setups | Setup and every job check the bot's position and permissions first and fail with a clear fix |
| Discord limits: 500 channels per guild, 50 per category, 5 inputs per modal | Day size checked against limits before opening; the penalty form uses command options + a 2-field modal (S2) |
| Privileged intents revoked or not enabled | Checked at boot and setup; transcripts degrade to "bot messages only" with a warning rather than failing |
| Attendance endpoint not ready | Manual entry path; import ships behind its own milestone |
| Penalty guideline changes each season | Catalog is data with a `season`; seeded, editable |
| Single process: a bot crash takes the site down (or the reverse) | Same process is a deliberate trade (ADR-0001); the bot client reconnects on its own and errors in handlers are contained per interaction |

## 13. Spikes before building (timeboxed)

- **S1 Discord OAuth on a LAN install.** Which redirect URIs Discord accepts (plain `http://<lan-ip>`,
  Tailscale MagicDNS, HTTPS via a reverse proxy); document the supported setups.
- **S2 Penalty form ergonomics.** Command options + modal vs. the newer select-in-modal components; time
  a judge recording a penalty on a phone.
- **S3 Permissions in a real guild.** Bot role position vs. member overwrites, category vs. channel
  overwrites, and what an admin with Administrator still sees (organizers will).
- **S4 Transcript export.** History paging speed and attachment sizes for a busy day; MessageContent behaviour.

## 14. Delivery plan

| Milestone | Scope |
| --------- | ----- |
| M0 | Spikes S1–S4 |
| M1 Skeleton | Nuxt app, DB, vault, secret bootstrap, setup wizard, Discord login, bot online, image + CI + Unraid template |
| M2 Days and channels | Directory, blueprints, day plan, preview, open/sync jobs, privacy audit |
| M3 Attendance import | Adapter + fake, import/refresh diff, linking by player ID (needs the companion attendance issue) |
| M4 Penalties | Catalog, `/penalty`, cards, edit/void, website page, CSV |
| M5 Close-out | Lock, transcripts, exports page, grace + purge, retention sweep |

## 15. Resolved questions

Answered by the owner on 2026-10-13:

- **Q1 Penalty CSV format.** The columns, order and quoting of the sample (§6.6) are the contract, with
  LF line endings. A human reads it, so label wording doesn't matter; Genie writes the clipboard labels.
- **Q2 Audiences.** Every per-event channel is visible only to that event's staff (§6.2).
- **Q3 Retention.** Transcripts are kept 90 days and penalty records and CSVs 1 year, both configurable.
- **Q4 Organizer access.** The organizer role sees every day channel in Discord.
- **Q5 Name and age division.** Not collected (§6.7).

## 16. Architecture Decision Records

| ADR | Title | Status |
| --- | ----- | ------ |
| [0001](adr/0001-modular-monolith-nuxt-with-bot.md) | Modular monolith on Nuxt 4 with the Discord bot in-process | Proposed |
| [0002](adr/0002-sqlite-drizzle.md) | SQLite (WAL) + Drizzle, exports on disk | Proposed |
| [0003](adr/0003-discord-gateway-and-port.md) | Discord through discord.js over the gateway, behind a `DiscordGateway` port | Proposed |
| [0004](adr/0004-discord-login-and-roles.md) | Website login with Discord OAuth; access from guild roles and day roles | Proposed |
| [0005](adr/0005-channels-as-desired-state.md) | Fresh channels per day, provisioned as desired state with member overwrites | Proposed |
| [0006](adr/0006-structured-penalties.md) | Penalties as structured records through `/penalty`, catalog as data | Proposed |
| [0007](adr/0007-close-out-export-then-delete.md) | Close-out: lock, export, then delete after a grace period | Proposed |
| [0008](adr/0008-attendance-integration.md) | Pull a day snapshot from attendance through a read-only token API | Proposed |
| [0009](adr/0009-docker-on-unraid.md) | One Docker container on Unraid, beside attendance | Proposed |
