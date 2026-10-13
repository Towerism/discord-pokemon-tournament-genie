# ADR-0008: Pull a day snapshot from attendance through a read-only token API

- Status: Accepted (2026-10-13)
- Date: 2026-10-13
- Companion: needs a matching ADR, issue and spec in
  [play-pokemon-attendance-web](https://github.com/Towerism/play-pokemon-attendance-web) for the endpoint and its token.
  The endpoint aggregates across every connected professor, as attendance's own day view already does
  (attendance ADR-0009, #75).

## Context

The organizer already records, in attendance:

- each date's tournaments, read from play-tools as their organizer (attendance ADR-0009). Several
  professors' Pokémon accounts can be connected to attendance at once (up to 10, attendance ADR-0008),
  and on one day different professors may organize different tournaments;
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

- **The contract** (architecture §4.2): the date, the store timezone, and the tournaments of **every
  professor connected to attendance** that start on the date, each read as its organizer and listed once
  even when two professors list it. For each tournament: its GUID, name, display ID, UTC start, game
  (when known), `organizer` (the professor's player ID and name) and live staff assignments (player ID,
  local name, role). A `professors` list names every connected professor with `status` (`read` or
  `unread`) and, when unread, a `reason` (`needs_reconnect`, `read_failed`). The endpoint is versioned
  (`v1`) and read-only.
- **Auth:** attendance mints a token (shown once, stored hashed there) with a read-only integrations
  scope. Genie keeps it in its vault and sends it as `Authorization: Bearer`. Revocable in attendance.
- **Every connected organizer, in one import.** All returned tournaments become events. Each records
  its attendance organizer, and the day plan shows it. The organizer removes any events they don't want
  afterwards; Genie doesn't filter by professor.
- **Unreadable organizers never cost data.** With any `unread` professor, the import still takes everyone
  else's tournaments and warns, naming each unread professor and the reason. The refresh diff (a pure
  function in `attendance-import`) never proposes removing an event, or its staff, whose organizer is
  unread; those show as "not refreshed". Only a read organizer's absent tournament can be proposed for
  removal. Otherwise an expired connection would look like cancelled tournaments, and accepting the diff
  would revoke staff's channel access (ADR-0005).
- **No connected organizers:** the import is refused (`422 no_connected_organizers`) and the plan is unchanged.
- **Snapshot semantics:** importing copies the data into Genie's day plan with `source = attendance` and
  upstream IDs. **Refresh** re-pulls and shows a diff to accept. Genie never silently overwrites
  edits, and every field can be entered by hand if attendance is down. Accepting a diff that removes
  staff queues a sync at once (ADR-0005).
- **Same timezone or no import.** If the response's `timezone` differs from Genie's `TZ`, Genie refuses
  the import (`422 timezone_mismatch`) and shows both zones, because start times and the day's date would
  otherwise shift.
- **Unknown game.** `game: null` is imported as `game = 'other'` with `game_confirmed = false`. The
  organizer sets the game before the day can be opened, because the game decides which penalties are
  offered.
- **Identity mapping** is Genie's (architecture §5.3). Staff link a player ID to their Discord account
  (organizer-linked, or self-claimed and organizer-confirmed). Unlinked imported staff get no channel
  access until linked. Imported names only seed new directory rows.
- **The port:** `AttendanceSource.getDay(date)`; only `server/modules/attendance/adapters/http/` makes
  the call. Tests use a recorded contract fixture and an in-process HTTP fake, so Genie and the attendance
  endpoint can be built in parallel.

## Consequences

- (+) The organizer enters staffing once, in attendance; Genie reuses it, for every connected professor's
  tournaments in one import.
- (+) A professor whose connection lapsed can't make a refresh remove staff.
- (+) Loose coupling: one versioned, read-only endpoint; attendance stays unaware of Discord.
- (+) Tournament display IDs come across for the CSV.
- (−) Cross-repo work: attendance needs an endpoint, token management and its own ADR.
- (−) The endpoint reads play-tools live, once per connected professor (tournaments aren't cached in
  attendance), so an import can be slow or partially `unread`; the diff UI shows that.
- (−) Snapshots go stale; staleness is visible ("imported 2 h ago"), and refresh is one click.
