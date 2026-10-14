# S1: OAuth redirect URIs for the website login

Which redirect URIs does Discord accept for Genie's website login, and which setups complete a login
([architecture §13](../architecture/README.md#13-spikes-before-building-timeboxed),
[ADR-0004](../architecture/adr/0004-discord-login-and-roles.md))? The spike was planned around reaching
Genie directly on the LAN. Its result is why Genie isn't served that way: the website is reached only
through Caddy as an HTTPS reverse proxy ([ADR-0013](../architecture/adr/0013-https-origin-for-website-login.md)),
so the production redirect URI is `https://<caddy-host>/auth/discord`.

- **Recorded:** 2026-10-14, Discord API v10, the owner's browser: Chrome 154 on Linux. No other browser
  was tested. The Caddy row is different: it was recorded later, from Genie itself rather than the harness
  (see below the table).
- **Harness:** `pnpm spike s1 serve` on the test host (port 3001, redirect path `/auth/discord`), one run
  per setup and cookie mode. Each login used the `identify` scope and a random 32-byte `state` set as an
  `HttpOnly; SameSite=Lax` cookie, `Secure` unless `--insecure-cookie`.
- **Raw data:** `spikes/out/s1-attempts.jsonl` (git-ignored; it holds the real addresses). It has 7
  records: the 6 attempts below plus 1 diagnostic (see *Why the cookie goes missing*).

## Results

| Setup | Portal accepts the URI | Authorize accepts it | Round trip, `Secure` cookie | Round trip, non-`Secure` cookie |
| ----- | ---------------------- | -------------------- | --------------------------- | ------------------------------- |
| `http://localhost:3001` | yes | yes | **ok** | **ok** |
| `http://<lan-ip>:3001` | yes | yes | `state_cookie_missing` | `state_cookie_missing` |
| `http://<hostname>.local:3001` (mDNS) | yes | yes | `state_cookie_missing` | `state_cookie_missing` |
| `http://<magicdns-name>:<port>` (Tailscale, plain HTTP) | not tested — Tailscale not installed on the test host; not a supported setup | | | |
| `https://<machine>.<tailnet>.ts.net` (Tailscale Serve) | not tested — Tailscale not installed on the test host; not a supported setup | | | |
| `https://<caddy-host>` (Caddy HTTPS reverse proxy, **the supported setup**) | yes | yes | **ok** | not applicable: Genie's cookies are always `Secure` |

**The Caddy row** was recorded on 2026-10-14, after M1 ([#15](https://github.com/Towerism/discord-pokemon-tournament-genie/issues/15)),
from the owner's report:
- Genie itself ran behind Caddy over HTTPS (not the spike harness), and was set up through its wizard;
- in Chrome (version not recorded), a "Log in with Discord" completed at `https://<caddy-host>/auth/discord`
  (`<site>` in the deploy guide). The yes/yes cells follow from that: the redirect URI must have been
  registered in the portal and accepted at authorize for the login to complete;
- the certificate chains to GTS Root R4 (Google Trust Services), so it is publicly trusted. How it was issued
  wasn't recorded.

Genie's session and state cookies are `Secure` by configuration (`runtimeConfig.session.cookie`, and the login
route's state cookie), which is why the non-`Secure` column doesn't apply.

The plain-HTTP rows show why Genie isn't served directly: only `localhost` works, and that's for development
and for the owner on the host itself (including over an SSH tunnel). The supported setup is the Caddy row.

- Discord accepted every plain-HTTP redirect URI, both in the developer portal and at the authorize step.
  Discord itself doesn't require HTTPS.
- Only `localhost` completed a login. On the LAN IP and the `.local` name, Discord redirected back with a
  valid code, but the browser didn't send the state cookie, so the callback couldn't verify `state`.
- On this host the `.local` name also resolved to Docker bridge addresses as well as the LAN address. It
  made no difference here (the result matched the LAN IP), but an install guide that suggests `.local`
  should expect that.
- Discord showed the consent screen on every login, including repeats with the same scope. Repeat logins
  weren't skipped.

## Why the cookie goes missing

- **`Secure` cookies** over plain HTTP are expected to fail: browsers drop `Secure` cookies set by a
  non-secure origin, and treat only `localhost` as secure without HTTPS.
- **Non-`Secure` cookies** failing was not expected. A diagnostic settled where it fails: after a login
  attempt on the LAN IP, a same-site visit to the callback with a made-up `state` returned
  `state_mismatch`, not `state_cookie_missing`. So Chrome **stored** the cookie and sends it on same-site
  requests, but **withheld** it on the top-level redirect back from `discord.com` to the private address.
  The `.local` setup behaved the same way.
- **Hypothesis (not verified):** Chrome's local-network protections (Local Network Access / Private
  Network Access) restrict what a public site's navigation into a private address carries. This spike
  didn't isolate the Chrome feature or test other browsers; the practical result stands either way.

## What it means for Genie

**Contradiction with the architecture.** Genie's login
([ADR-0004](../architecture/adr/0004-discord-login-and-roles.md)) uses `nuxt-auth-utils`, with sealed,
`SameSite=Lax` cookies, and the OAuth flow relies on the browser carrying state across the redirect back from
Discord. [ADR-0009](../architecture/adr/0009-docker-on-unraid.md) treated (before ADR-0013) plain-HTTP LAN use
as the baseline and asked for Tailscale or an HTTPS reverse proxy only for remote use. On Chrome, a plain-HTTP
LAN address (IP or `.local`) can't complete that login, so the baseline doesn't hold for the website.

The amendment is [ADR-0013](../architecture/adr/0013-https-origin-for-website-login.md), **accepted by the
owner on 2026-10-14**: the website login needs an HTTPS origin, and an HTTPS reverse proxy through Caddy is
the only supported setup, with `http://localhost` only for development and for the owner on the host itself
(including over an SSH tunnel). Tailscale and other proxies are not supported, so their rows above stay `not
tested`. The Caddy setup wasn't available during the spike. The owner moved its test to before the first
release (#11). On 2026-10-14 the owner reported a completed login at `https://<caddy-host>/auth/discord`
through Caddy in Chrome, which also shows that the redirect URI was registered and accepted (the Caddy row
above). ADR-0013 holds.

## Timebox

About an hour of the owner's 0.5-day S1 budget, driven from the owner's browser on the test host.
