# ADR-0009: One Docker container on Unraid, beside attendance

- Status: Accepted (2026-10-13)
- Amended by [ADR-0011](0011-share-infrastructure-through-selfhost-kit.md) (accepted 2026-10-13)
- Amended by [ADR-0013](0013-https-origin-for-website-login.md) (accepted 2026-10-14). Website login
  needs Caddy as an HTTPS reverse proxy, even on the LAN (S1); it's the only supported setup.
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

Option 1, with the shared pieces from `@towerism/selfhost-kit` (ADR-0011):

- the kit's `runLauncher` and `prepareRuntimeEnv`, with its `/data/secrets` contract: the directory 0700,
  each secret file generated once with mode 0600;
- the kit's Docker assets (the entrypoint with PUID/PGID, gosu, UMASK and optional Litestream;
  `litestream.yml`; the Litestream pin), copied into the build with `selfhost-kit docker-assets`;
- the kit's reusable `app-image.yml` and `app-release.yml` workflows, pinned by SHA, with its shareable
  semantic-release config and PR images;
- Genie's own Dockerfile, which adds `exports/` and port **3001** (the default), so it sits beside
  attendance's 3000.

Persistent data is `/data/app.db`, `/data/secrets/` and `/data/exports/`. No Discord or attendance
credentials go in the template; they are entered in `/setup` and Settings and kept in the vault.

## Consequences

- (+) Same install, update and backup routine the owner already knows.
- (+) Data stays on the owner's hardware.
- (−) Remote use (a head judge downloading the CSV from home) needs the owner's existing remote access:
  Caddy as an HTTPS reverse proxy, the only supported setup ([ADR-0013](0013-https-origin-for-website-login.md)).
  Documented in the deploy guide.
- (−) The backup holds `secrets/` with `app.db` and `exports/`, so it can open the vault; keep it private
  (Genie's deploy guide says so).
