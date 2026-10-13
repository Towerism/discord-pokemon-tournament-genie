# ADR-0009: One Docker container on Unraid, beside attendance

- Status: Proposed
- Date: 2026-10-13

## Context

The owner runs attendance as a Docker container on Unraid with a template that has no required fields,
everything persistent under `/data`, PUID/PGID 99/100, `TZ` honoured, and credentials entered in the
browser. Genie should install and back up the same way, on the same box.

## Options considered

1. **Same pattern as attendance:** a single `linux/amd64` image on GHCR, an Unraid template, `/data`
   appdata.
2. **Hosted (Fly.io, a VPS).** Always reachable and with public HTTPS, but costs money and moves minors'
   data off the owner's hardware; nothing here needs to be public (ADR-0003).

## Decision

Option 1, reusing attendance's pieces:

- the launcher with secret bootstrap (`/data/secrets/` generated once, mode 0600);
- the entrypoint (PUID/PGID, gosu, UMASK, optional Litestream);
- the CI pipeline with semantic-release and PR images.

Default port **3001** so it sits beside attendance's 3000. Persistent data is `/data/app.db`,
`/data/secrets/` and `/data/exports/`. No Discord or attendance credentials go in the template; they are
entered in `/setup` and Settings and kept in the vault.

## Consequences

- (+) Same install, update and backup routine the owner already knows.
- (+) Data stays on the owner's hardware.
- (−) Remote use (a head judge downloading the CSV from home) needs the owner's existing remote access:
  Tailscale or an HTTPS reverse proxy. Documented in the deploy guide.
- (−) The backup holds `secrets/` with `app.db` and `exports/`, so it can open the vault; keep it private
  (as attendance's guide says).
