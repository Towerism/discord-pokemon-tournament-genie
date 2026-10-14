# ADR-0002: SQLite (WAL) + Drizzle, with exports as files on disk

- Status: Accepted (2026-10-13)
- Amended by [ADR-0011](0011-share-infrastructure-through-selfhost-kit.md) (proposed 2026-10-13)
- Date: 2026-10-13

## Context

The data is small and relational: a day has events, staff, channels and penalties, and a store holds a
few days a month. One process writes (ADR-0001). Exports (CSVs, transcripts, attachments) can be
megabytes per day and are written once, then downloaded. Attendance already runs SQLite + Drizzle with
Litestream on the same Unraid box.

## Options considered

1. **SQLite (WAL) via Drizzle + `better-sqlite3`; export files under `/data/exports/`.**
2. **PostgreSQL.** More capable, but a second container to install and back up, for no need.
3. **Everything in SQLite, including transcripts as blobs.** One file to back up, but bloats the DB and
   Litestream replicas with write-once data.

## Decision

Option 1. Schema in `server/db/schema.ts`, drizzle-kit migrations, never edit a shipped migration.
Export files live in `/data/exports/<day-id>/`, each recorded in `export_file` with its SHA-256, which
the purge step checks (ADR-0007). Discord snowflakes and player IDs are TEXT.

## Consequences

- (+) Zero ops; the same tooling as attendance, and the same backup story: Appdata Backup, plus optional
  Litestream with its config from `@towerism/selfhost-kit` (ADR-0011).
- (+) Hash records make a missing or altered export detectable before channels are deleted.
- (−) Litestream covers the DB, not `exports/`; the Appdata Backup of the whole folder covers both.
- (−) Single writer; acceptable at this scale.
