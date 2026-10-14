# ADR-0013: Website login needs an HTTPS origin, through Caddy

- Status: Accepted (2026-10-14, owner decision: an HTTPS reverse proxy through Caddy is the only supported setup)
- Amends [ADR-0004](0004-discord-login-and-roles.md), [ADR-0009](0009-docker-on-unraid.md) and
  architecture §10
- Date: 2026-10-14

## Context

ADR-0004 logs people into the website with Discord OAuth through `nuxt-auth-utils`, using sealed,
`SameSite=Lax` cookies. The OAuth flow depends on the browser carrying state across the redirect back from
Discord. ADR-0009 runs Genie as a container on the owner's LAN and asks for Tailscale or an HTTPS reverse
proxy only for remote use, so plain `http://<lan-ip>:3001` was the implied local setup.

Spike S1 ([findings](../../spikes/s1-oauth-redirects.md)) tested this in Chrome 154:

- Discord accepts plain-HTTP redirect URIs (LAN IP, `.local`, `localhost`), in the portal and at authorize.
- Only `http://localhost` completed a login. On the LAN IP and the `.local` name, the state cookie was
  missing at the callback, with or without `Secure`.
- A diagnostic showed the non-`Secure` cookie was stored and sent on same-site requests, but withheld on
  the redirect from `discord.com` to the private address. The exact Chrome feature is a hypothesis
  (local-network protections), not verified.
- The HTTPS setups (Tailscale Serve, a reverse proxy) weren't available, so they weren't tested.

So the implied plain-HTTP LAN setup can't log anyone into the website on Chrome.

## Options considered

1. **Require an HTTPS origin for the website**; `http://localhost` only for development and for the owner on
   the host itself (including over an SSH tunnel). Keeps `nuxt-auth-utils` and `Secure` cookies as designed.
   Costs the owner an HTTPS setup even for LAN-only use. Two ways to provide it were considered: Tailscale
   Serve, or an HTTPS reverse proxy. The owner chose the reverse proxy, through Caddy only (see Decision).
2. **Keep plain HTTP and stop relying on a cookie across the redirect**: bind `state` server-side and set
   a non-`Secure` session cookie on the callback (same-site, which S1 showed Chrome does send). Rejected:
   `state` not bound to the browser loses login-CSRF protection, a non-`Secure` session cookie on plain
   HTTP can be read by anyone on the network, it means replacing `nuxt-auth-utils`' OAuth handler, and it
   rests on browser behaviour this spike couldn't explain.
3. **Support `localhost` only.** Rejected: head judges use the website from their own devices.

## Decision

Option 1, with one supported setup (owner decision, 2026-10-14).

- The website's public URL (`NUXT_PUBLIC_SITE_URL`) MUST be an `https://` origin served by **Caddy** as a
  reverse proxy in front of Genie. The setup wizard refuses to accept secrets, and login refuses with a
  clear message, on any origin other than `NUXT_PUBLIC_SITE_URL` (`https://`) or `http://localhost`.
- Genie's port is published only on the host's loopback (`127.0.0.1:3001`) or not at all, never to the
  LAN. Before Caddy is configured, the owner reaches `/setup` through an SSH tunnel to the host
  (`ssh -L 3001:127.0.0.1:3001 <host>`, then `http://localhost:3001`); afterwards, at
  `NUXT_PUBLIC_SITE_URL`. `NUXT_PUBLIC_SITE_URL` is an optional template field; without it, `/setup` is
  reachable only through that localhost path.
- Caddy is the only supported HTTPS setup. Tailscale Serve, other reverse proxies and plain HTTP on the
  LAN are not supported; the deploy guide documents only the Caddy setup.
- `http://localhost:<port>` stays allowed for development and for the owner on the host itself (including over
  an SSH tunnel). Login and the setup wizard exempt it from the origin (`https://`) check only. Cookies stay
  `Secure` there: Chrome treats `localhost` as a secure context, and S1's localhost row completed with a
  `Secure` cookie.
- Before M1's login work, the Caddy setup is tested the way S1 tested the others (portal, authorize, full
  round trip with a `Secure` cookie). If it doesn't work, this ADR is revisited.

## Consequences

- (+) Login keeps `Secure`, sealed cookies and `nuxt-auth-utils`' state check, unchanged.
- (+) Session cookies never cross the LAN in clear text, provided the obligations below hold.
- (+) One supported setup keeps the deploy guide, the wizard's checks and support simple.
- Obligations for the deploy guide and M1:
  - Caddy runs on the same host as Genie. They share a dedicated Docker network that only Caddy joins
    besides Genie, or Caddy has a fixed IP on it.
  - Genie's port is never published to the LAN: only on the host's loopback (`127.0.0.1:3001`), or not at
    all.
  - Genie trusts forwarded headers (`X-Forwarded-*`) only from that network or Caddy's fixed address.
  - The login rate limiter keys on the client address Caddy sets: the rightmost `X-Forwarded-For` entry,
    which Caddy appends, never the leftmost, which the client controls.
  - The deploy guide states the certificate source:
    - recommended: a public domain with Caddy's ACME DNS-01 challenge, which needs no inbound exposure;
    - not recommended: ACME HTTP-01, which needs ports 80 and 443 open to the internet;
    - if Caddy's internal CA is used instead, the guide states the interception risk of installing a root
      CA on judges' devices, keeps Caddy's data directory (which holds the CA key) out of shared backups,
      and tells judges how to remove the root afterwards.
  - The OAuth redirect URL is pinned to `NUXT_PUBLIC_SITE_URL` + `/auth/discord`, never derived from the
    request.
  - The setup wizard refuses secrets on any origin but `NUXT_PUBLIC_SITE_URL` or `http://localhost`.
- (−) Even LAN-only use of the website needs Caddy in front of Genie. The Discord side (the bot) is
  unaffected; only the website login needs it.
- (−) Owners who already use Tailscale Serve or another proxy must add Caddy.
- (−) The Caddy setup wasn't tested in S1; that test is a precondition for M1's login work.
