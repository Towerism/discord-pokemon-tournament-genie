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
| `exports/` | penalty CSVs and transcripts (from milestone M5) |

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

1. Create a Docker network that only Caddy and Genie join:

   ```sh
   docker network create genie
   ```

   In Unraid, set both containers' **Network Type** to `genie`. This needs *Settings → Docker → Preserve
   user defined networks: Yes*. Genie keeps its loopback port, so the tunnel still works.
2. Caddyfile:

   ```caddyfile
   <site> {
       reverse_proxy tournament-genie:3001
   }
   ```

   Caddy sets `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-For`. Genie believes them only from a
   trusted proxy. The default is loopback plus Docker's bridge pool (`172.16.0.0/12`). If your `genie` network
   uses another range, set **Trusted proxies** to that network's subnet, or to Caddy's fixed address on it.
   Genie rate-limits logins by the address Caddy appends (the rightmost `X-Forwarded-For` entry).
3. **Certificates:**
   - Recommended: a public domain with Caddy's ACME **DNS-01** challenge. It needs no inbound ports
     (Caddy's DNS-provider module).
   - Not recommended: ACME HTTP-01. It needs ports 80 and 443 open to the internet.
   - Caddy's internal CA (`tls internal`) works only if every judge's device trusts its root. Installing a root
     CA on a device lets whoever holds its key intercept that device's HTTPS. Keep Caddy's data folder, which
     holds the key, out of shared backups, and tell judges how to remove the root afterwards.
4. In Genie's template, set **Site URL** to `https://<site>`, with no path, and **Apply**. Genie refuses to
   start on an `http://` site URL.

From now on the website is `https://<site>`. Secrets and logins are refused on any other address except
`http://localhost:3001` through the tunnel.

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
- **Update:** click *Update* on the container in Unraid. Nothing changes on its own.
- **Roll back:** set the template's *Repository* to the previous `ghcr.io/towerism/discord-pokemon-tournament-genie:X.Y.Z`
  (or `sha-…`) and **Apply**. A bad release is also fixed upstream by reverting its commit, which releases a
  new patch.

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
- [ ] Set `RELEASES_ENABLED=true`. The next releasable commit on `main` is released as the first version.

**If the Caddy round trip fails,** leave releases off and revisit ADR-0013 before anything else. It is the
only supported way to log in to the website.
