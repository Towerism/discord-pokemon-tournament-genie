# ADR-0008: Pull a day snapshot from attendance through a read-only token API

- Status: Proposed
- Date: 2026-10-13
- Companion: needs a matching ADR, issue and spec in
  [play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web) for the endpoint and its token.

## Context

The organizer already records, in attendance:

- each date's tournaments, read from play-tools as their organizer (attendance ADR-0009);
- the staff assigned to each tournament, with a player ID and a play-tools role (attendance ADR-0007,
  table `staff_assignment`).

The owner wants Genie to use that in v1 instead of re-entering it. Genie's CSV also needs each
tournament's play-tools display ID (ADR-0006), which attendance knows.

Constraints:

- Genie must never call play-tools itself.
- Attendance is a separate app (single organizer login, LAN install) whose module rules forbid other
  modules reading its tables, let alone another app.
- Attendance identifies people by **player ID**, Discord by **user ID**.

## Options considered

1. **Genie pulls from a new read-only attendance endpoint** (`GET /api/integrations/v1/days/{date}`),
   authenticated by a bearer token minted in attendance's Settings, on the organizer's click.
2. **Attendance pushes to Genie** when staff change. Fresher, but attendance would need to know about
   Genie, retry deliveries and hold Genie's credentials.
3. **Share the SQLite file.** No API work, but couples schemas across apps and breaks both apps' rules.
4. **CSV/JSON export from attendance, uploaded to Genie.** Loosest coupling, more clicks every week.

## Decision

Option 1.

- **The contract** (architecture §4.2): the date, the store timezone, and for each tournament its GUID,
  name, display ID, UTC start, game (when known) and live staff assignments (player ID, local name,
  role). An `unread` list names professors attendance couldn't read. The endpoint is versioned (`v1`)
  and read-only.
- **Auth:** attendance mints a token (shown once, stored hashed there) with a read-only integrations
  scope. Genie keeps it in its vault and sends it as `Authorization: Bearer`. Revocable in attendance.
- **Snapshot semantics:** importing copies the data into Genie's day plan with `source = attendance` and
  upstream IDs. **Refresh** re-pulls and shows a diff to accept. Genie never silently overwrites
  edits, and every field can be entered by hand if attendance is down.
- **Identity mapping** is Genie's (architecture §5.3). Staff link a player ID to their Discord account
  (organizer-linked, or self-claimed and organizer-confirmed). Unlinked imported staff get no channel
  access until linked. Imported names only seed new directory rows.
- **The port:** `AttendanceSource.getDay(date)`; only `server/modules/attendance/adapters/http/` makes
  the call. Tests use a recorded contract fixture and an in-process HTTP fake, so Genie and the attendance
  endpoint can be built in parallel.

## Consequences

- (+) The organizer enters staffing once, in attendance; Genie reuses it.
- (+) Loose coupling: one versioned, read-only endpoint; attendance stays unaware of Discord.
- (+) Tournament display IDs come across for the CSV.
- (−) Cross-repo work: attendance needs an endpoint, token management and its own ADR.
- (−) The endpoint reads play-tools live (tournaments aren't cached in attendance), so an import can be
  slow or partially `unread`; the diff UI shows that.
- (−) Snapshots go stale; staleness is visible ("imported 2 h ago"), and refresh is one click.
