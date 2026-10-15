# Deploying Tournament Genie on Unraid

Genie runs as one container on Unraid, beside attendance ([ADR-0009](architecture/adr/0009-docker-on-unraid.md)).
The website is reached **only through Caddy**, as an HTTPS reverse proxy in its own container
([ADR-0013](architecture/adr/0013-https-origin-for-website-login.md)). Genie's port is published only on the
server's loopback, never to the LAN. This is the one supported setup. Tailscale Serve, other proxies and plain
HTTP on the LAN are not supported, because Discord logins fail on them.

Placeholders used below: `<unraid>` is your Unraid server, and `<site>` is the public name Caddy serves
Genie on (for example `genie.example.com`).

## 1. Install the container

1. In Unraid, go to **Docker → Add Container** and use the template
   `https://raw.githubusercontent.com/Towerism/discord-pokemon-tournament-genie/main/deploy/unraid/tournament-genie.xml`.
2. Nothing is required. Leave **Site URL** empty for now and **Apply**.
3. The template publishes port 3001 only on `127.0.0.1` (`-p 127.0.0.1:3001:3001` under *Extra Parameters*).
   Don't add a port mapping to the LAN.

Everything Genie keeps lives in the appdata folder (`/mnt/user/appdata/tournament-genie`, mounted at `/data`):

| Path | Contents |
| ---- | -------- |
| `app.db` | the database (SQLite, WAL) |
| `secrets/` | `session-password` and `vault.key`, generated on first boot (mode 0600). The vault key unseals the Discord credentials stored in `app.db`. |
| `exports/` | penalty CSVs, transcripts and attachments of closed days, kept for the retention set in Settings (90 days for transcripts, a year for penalties, by default) |

The image is `ghcr.io/towerism/discord-pokemon-tournament-genie`. If Unraid can't pull it, the GHCR package
isn't public yet. Make it public under the repository's **Packages** settings, or log in to `ghcr.io` on Unraid.

## 2. First run, before Caddy: the SSH tunnel

The container log prints a one-time setup code:

```
[2026-10-18 09:00:00.000] INFO: [setup] Setup isn't finished. Open /setup and enter this setup code: ABCD-EFGH
```

A new code is printed on every start until setup is finished. From your own computer:

```sh
ssh -L 3001:127.0.0.1:3001 root@<unraid>
```

Then open `http://localhost:3001/setup`. Chrome treats `http://localhost` as secure, so the login works there.
Use port 3001 locally too: the Discord redirect URL below names it.

## 3. The Discord application

In the [Discord developer portal](https://discord.com/developers/applications):

1. **New Application**. On the **Bot** page:
   - turn **Public Bot** off;
   - turn on the **Server Members** and **Message Content** intents;
   - reset and copy the **token**.
2. On the **OAuth2** page, copy the **client ID** and **client secret**, and add these redirects:
   - `http://localhost:3001/auth/discord` (setup through the tunnel);
   - `https://<site>/auth/discord` (once Caddy is in place).
3. In the wizard:
   - paste the three values;
   - invite the bot with the link it shows (it asks for exactly the 13 permissions Genie needs, never
     Administrator);
   - choose the server;
   - **log in with Discord** (that account becomes the install owner);
   - map the organizer and head-judge roles;
   - **Finish**.

   The wizard checks every step live against Discord. Drag the bot's role above both mapped roles in
   **Server Settings → Roles** if it asks you to.

Anyone in the server with *Manage Roles* can hand out the organizer role, and with it full access. The owner can
limit organizers with the allowlist in **Settings**.

## 4. Caddy

1. **A dedicated network** that only Caddy and Genie share, with a subnet you choose (Genie trusts forwarded
   headers only from it):

   ```sh
   docker network create --subnet 172.31.53.0/24 genie
   ```

   - Set Genie's **Network Type** to `genie`. This needs *Settings → Docker → Preserve user defined networks:
     Yes*.
   - If Caddy already serves other sites on another network, don't move it. Attach it to `genie` as well:
     `docker network connect genie caddy`, and run that again whenever the Caddy container is recreated, or
     add `--network genie` under its *Post Arguments*. A new Caddy can simply use `genie` as its network.
   - In Genie's template, set **Trusted proxies** to `172.31.53.0/24` (or to Caddy's fixed address on it).
     ADR-0013 asks Genie to believe `X-Forwarded-*` only from that network.
2. **Caddy publishes the HTTPS port.** Caddy, not Genie, is what judges' devices reach: publish 443 on the
   host (and 80 only for the HTTP-01 challenge below).
3. **The name resolves to Unraid.** `<site>` must resolve to the Unraid server's LAN address on judges' devices:
   - a public DNS record pointing at the LAN address (fine for a LAN-only site); or
   - split DNS on your router.
4. **Caddyfile:**

   ```caddyfile
   <site> {
       reverse_proxy tournament-genie:3001
   }
   ```

   Caddy sets `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`. Genie rate-limits logins by the
   address Caddy appends (the rightmost `X-Forwarded-For` entry), never one the client sent.
5. **Certificates:**
   - Recommended: a public domain with Caddy's ACME **DNS-01** challenge. It needs no inbound ports. The stock
     `caddy` image has no DNS-provider modules, so use an image built with your provider's module (for
     example with `xcaddy`, or a community image that includes it).
   - Not recommended: ACME HTTP-01. It needs ports 80 and 443 open to the internet.
   - Caddy's internal CA (`tls internal`) works only if every judge's device trusts its root. Installing a root
     CA on a device lets whoever holds its key intercept that device's HTTPS. Keep Caddy's data folder, which
     holds the key, out of shared backups, and tell judges how to remove the root afterwards.
6. In Genie's template, set **Site URL** to `https://<site>`, with no path, and **Apply**. Genie refuses to
   start on an `http://` site URL.

From now on the website is `https://<site>`. Secrets and logins are refused on any other address except
`http://localhost:3001` through the tunnel.

**The loopback port.** Docker Engine releases before 28.0 let other hosts on the same LAN segment reach ports
published on `127.0.0.1`. Check yours with `docker version` on Unraid. On an older engine, or if you prefer,
remove `-p 127.0.0.1:3001:3001` from *Extra Parameters* once Caddy works: the website no longer needs it, and
for maintenance you can tunnel to Caddy's address instead.

## 5. Backups and restore

- **Back up the whole appdata folder** with *Appdata Backup*: `app.db`, `secrets/` and `exports/` together.
  `secrets/vault.key` is what unseals the stored Discord credentials. A backup without it restores a Genie
  whose bot can't log in, with the status *secrets unreadable*.
- The backup can open the vault, so keep it private.
- **Restore:** stop the container, put the backed-up folder back in place, and start the container. The
  startup log says `Vault key: loaded from …`. If it says `generated into …`, `secrets/` wasn't restored. Stop
  the container and restore it too.
- **Optional, Litestream:** set **Litestream replica URL** (for example `s3://bucket/genie`) and its keys in the
  template's advanced fields. Only the database is replicated, never `secrets/`. A fresh `/data` restores the
  database from the replica at boot. Keep backing up the appdata folder for `secrets/`.

`test/docker/restore-drill.sh` and `test/docker/litestream.sh` run these procedures against every image CI
builds.

## 6. Updates and rollback

- Images:
  - `latest` and `X.Y.Z`: released versions;
  - `edge`: the newest `main`;
  - `sha-<commit>`: one commit;
  - `pr-<n>`: a pull request, for trying it.
- **Update:** take an Appdata Backup first, then click *Update* on the container in Unraid. Nothing changes on
  its own. An update may migrate the database, and an older version doesn't know a newer schema.
- **Roll back:**
  - Set the template's *Repository* to the previous `ghcr.io/towerism/discord-pokemon-tournament-genie:X.Y.Z`
    (or `sha-…`) and **Apply**.
  - If the update changed the database, also restore the backup you took before updating (section 5), so the
    old version runs on the schema it knows. Anything recorded since that backup is lost.
- **A bad release upstream:** revert its commit, which releases a new patch. To move `latest` back by hand
  until then:

  ```sh
  docker buildx imagetools create \
    --tag ghcr.io/towerism/discord-pokemon-tournament-genie:latest \
    ghcr.io/towerism/discord-pokemon-tournament-genie:<previous X.Y.Z>
  ```

## 7. First-release checklist (the owner, before releases are turned on)

The release job is off until the repository variable `RELEASES_ENABLED` is `true` (*Settings → Secrets and
variables → Actions → Variables*). Images still publish, so run `edge` or a `sha-…` tag for these steps:

- [ ] **The Caddy round trip** ([ADR-0013](architecture/adr/0013-https-origin-for-website-login.md)), the way
      S1 tested the other setups. Record it in the Caddy row of
      [`docs/spikes/s1-oauth-redirects.md`](spikes/s1-oauth-redirects.md):
      - the portal accepts `https://<site>/auth/discord`;
      - the authorize step accepts it;
      - a full login completes with a `Secure` cookie.
- [ ] **A smoke on the test guild** (Discord has no sandbox):
      - the bot shows *connected* in the page header;
      - the guild's slash commands are cleared;
      - a DM to the bot is ignored, and the log shows `interaction_dropped` with `direct_message`.
- [ ] **A real restore:** restore an Appdata Backup to a scratch folder, start a second container on it, and see
      `Vault key: loaded from`.
- [ ] Set `RELEASES_ENABLED=true`. Setting it starts nothing on its own. The next CI run on `main` releases:
      push to `main`, or re-run the latest `main` run under *Actions*. There is no tag yet and `main` already
      has `feat` commits, so that first release is **v1.0.0**, whatever type the triggering commit has.

**If the Caddy round trip fails,** leave releases off and revisit ADR-0013 before anything else. It is the
only supported way to log in to the website.

## 8. Dependency updates (Renovate)

Renovate keeps the dependencies current through PRs ([`renovate.json`](../renovate.json)); the design is in the
architecture's *Supply chain* row and selfhost-kit [ADR-0005](https://github.com/Towerism/selfhost-kit/blob/main/docs/architecture/adr/0005-versioning-and-security-fixes.md).

**What merges on its own.** Only the kit: one `selfhost-kit` PR moves `@towerism/selfhost-kit` and the kit's
workflow SHAs together, opens as soon as Renovate sees the release (no waiting period, any time of day), and
automerges a **patch or minor** once the required checks pass. It is committed as `fix(deps)`, so it releases a
Genie patch once releases are on (section 7). Everything else waits for you:
- a kit **major** never automerges;
- other npm packages are proposed only once a release is 3 days old, and are merged by hand;
- PRs from security alerts are labelled `security` and skip the waiting period;
- Node (`.node-version` and the Dockerfile's images) and pnpm (`packageManager` and the Dockerfile's
  `PNPM_VERSION`) each move as one PR;
- `spikes/` is never touched.

pnpm itself refuses packages newer than a day, so `pnpm-workspace.yaml` exempts the kit by name. What makes
that safe is the kit's npm trusted publishing with provenance from its own CI. The same trust covers the kit's
workflow SHAs, whose `image` job is one of the checks that gates the kit's own PR. Other packages aren't exempt: a
security fix released that same day fails its lockfile update until it is a day old, then succeeds on a later
run.

**When Renovate runs.** The hosted Renovate app runs on Mend's schedule, about every 4 hours (daily for some
repository states), so on its own it can miss ADR-0005's one-hour target for a kit security fix. For an urgent
fix, open the **Dependency Dashboard** issue and tick its box to run Renovate now.

**The `main` ruleset** lives in [`.github/rulesets/main.json`](../.github/rulesets/main.json). It requires a PR
and the checks CI reports on PRs, blocks force-pushes and deleting `main`, and has no bypass. That's what stops
an automerge from landing red. Apply it the first time, or re-apply it after editing the file:

```sh
repo=Towerism/discord-pokemon-tournament-genie
id=$(gh api "repos/$repo/rulesets?includes_parents=false" -q '.[] | select(.name == "main") | .id')
if [ -z "$id" ]; then gh api -X POST "repos/$repo/rulesets" --input .github/rulesets/main.json
else gh api -X PUT "repos/$repo/rulesets/$id" --input .github/rulesets/main.json; fi
```

It needs the repository settings *Allow auto-merge* and Dependabot alerts on (Renovate reads security alerts
from GitHub):

```sh
repo=Towerism/discord-pokemon-tournament-genie
gh api -X PATCH "repos/$repo" -F allow_auto_merge=true
gh api -X PUT "repos/$repo/vulnerability-alerts"
```

The order matters: merge `renovate.json`, then apply the ruleset and the two settings, and only then give the
Renovate GitHub App access to the repository. Without the ruleset, an automerge wouldn't wait for checks.

**When something goes wrong:**
- **A kit PR fails CI.** It stays open and nothing merges. Read the failing job. If the kit broke Genie, fix
  Genie in that PR's branch or a new PR, or close the PR and report it on the kit. Renovate reopens it for the
  next kit release.
- **A required check never reports**, so every PR waits on it: a CI job was renamed, or the kit renamed the
  `image` job inside its `app-image.yml` (the check is named `image / <kit job>`). Fix the context name in
  `main.json`, re-apply it as above, then merge. The unit tests catch a rename of Genie's own jobs, but not the
  kit's.
- **Merging past broken CI in an emergency:** there is no bypass. Turn the ruleset off, merge, and turn it back on:

  ```sh
  repo=Towerism/discord-pokemon-tournament-genie
  id=$(gh api "repos/$repo/rulesets?includes_parents=false" -q '.[] | select(.name == "main") | .id')
  gh api -X PUT "repos/$repo/rulesets/$id" -f enforcement=disabled   # then -f enforcement=active
  ```
- **A bad dependency update reached `main`:** revert its commit (a `fix(deps)` revert releases a new patch), and
  on Unraid pin the previous image tag until then (section 6).
  
## 9. Connect attendance

Genie imports each day's tournaments and staff from attendance ([ADR-0008](architecture/adr/0008-attendance-integration.md)).

1. In attendance, open *Settings → Integrations* and create a token. It is shown once; copy it.
2. In Genie, open *Settings → Attendance*. Enter attendance's address as Genie's container reaches it: a
   shared Docker network name (`http://attendance:3000`) or the host's LAN address (`http://192.168.1.10:3000`).
   Paste the token and save. Genie keeps it sealed in its vault and only shows its last four characters.
3. Changing the address needs the token again. To stop importing, remove the connection; days keep what they
   already imported. To cut Genie off for good, revoke the token in attendance.

Both apps must run with the same `TZ`, or Genie refuses the import and names both zones. Genie's container
uses Central time (`America/Chicago`) when the template's **Timezone** is blank; set it to attendance's zone
if the store is elsewhere. An unknown zone (a typo) stops Genie at boot, with the bad value in the log.

**Before the first release with M3:** import one real day from the owner's attendance and check that each
connected professor shows as read, or as not refreshed with the right reason.

## 10. Closing a day

**Close the day** (on the day page, or in `#head-judges`) locks the day's channels, exports them to `exports/`, and
deletes them after the grace period, only if the export holds everything in them. The grace period is 7 days; to
change it, set `GENIE_PURGE_GRACE` under the template's advanced fields (`36h`, `14d`; 1 hour to 90 days). A
value Genie can't read stops the container with a message naming it.

If a purge is refused, the page header says so and the day's **Exports** page lists why, with **Re-export**,
**Retry attachments** (after raising the cap in Settings) and **Discard**. Nothing is deleted until one of them
clears the reason. Retention (Settings → *Close-out*) deletes a closed day's exports later: transcripts after 90
days and penalties after a year by default, counted from the close.
