# ADR-0013: Website login needs an HTTPS origin

- Status: Proposed (M0 finding, awaiting owner acceptance)
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

1. **Require an HTTPS origin for the website** (Tailscale Serve, or an HTTPS reverse proxy the owner
   already runs); `http://localhost` only for development on the host. Keeps `nuxt-auth-utils` and
   `Secure` cookies as designed. Costs the owner an HTTPS setup even for LAN-only use.
2. **Keep plain HTTP and stop relying on a cookie across the redirect**: bind `state` server-side and set
   a non-`Secure` session cookie on the callback (same-site, which S1 showed Chrome does send). Rejected:
   `state` not bound to the browser loses login-CSRF protection, a non-`Secure` session cookie on plain
   HTTP can be read by anyone on the network, it means replacing `nuxt-auth-utils`' OAuth handler, and it
   rests on browser behaviour this spike couldn't explain.
3. **Support `localhost` only.** Rejected: head judges use the website from their own devices.

## Decision

Option 1 (recommended; awaiting the owner).

- The website's public URL (`NUXT_PUBLIC_SITE_URL`) MUST be an `https://` origin, through Tailscale Serve
  or an HTTPS reverse proxy. The setup wizard warns, and login refuses with a clear message, when it isn't.
- `http://localhost:<port>` stays allowed for development and for the owner on the host itself.
- The deploy guide documents the two HTTPS setups.
- Before M1's login work, the two HTTPS setups are tested the way S1 tested the others (portal, authorize,
  full round trip with a `Secure` cookie). If neither works, this ADR is revisited.

## Consequences

- (+) Login keeps `Secure`, sealed cookies and `nuxt-auth-utils`' state check, unchanged.
- (+) Session cookies never cross the LAN in clear text.
- (−) Even LAN-only use of the website needs Tailscale or a reverse proxy. The Discord side (the bot) is
  unaffected; only the website login needs it.
- (−) The HTTPS setups are recommended without having been tested in S1; that test is a precondition for
  M1's login work.
