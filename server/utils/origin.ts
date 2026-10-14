import { type TrustedProxies, normalizeAddress } from '@towerism/selfhost-kit';

/** What the origin rule reads from a request; the h3 wiring fills it in. */
export interface OriginRequest {
  /** The TCP peer. */
  remoteAddress: string | undefined;
  host: string | undefined;
  forwardedProto?: string | undefined;
  forwardedHost?: string | undefined;
  trusted: TrustedProxies;
}

export interface OriginConfig {
  /** `NUXT_PUBLIC_SITE_URL`: an https origin, or empty. */
  siteUrl: string;
  /** The port the server listens on. */
  port: number;
}

/** A DNS name or IPv4 address, or a bracketed IPv6 address, with an optional port. */
const HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/**
 * The origin a request was made to, or `null` when it can't be told. `X-Forwarded-*` count only from a
 * trusted proxy (Caddy, ADR-0013); anything else is plain HTTP to the `Host` it named.
 */
function requestOrigin(req: OriginRequest): string | null {
  const peer = normalizeAddress(req.remoteAddress);
  const viaProxy = peer !== null && req.trusted.contains(peer);
  const scheme = viaProxy && req.forwardedProto !== undefined ? req.forwardedProto.trim().toLowerCase() : 'http';
  const host = (viaProxy && req.forwardedHost !== undefined ? req.forwardedHost : req.host)?.trim();
  if (!host || !HOST.test(host) || (scheme !== 'http' && scheme !== 'https')) return null;
  return new URL(`${scheme}://${host}`).origin;
}

/** The origins secrets and logins are accepted on (ADR-0013): the site URL and the owner's localhost. */
function allowedOrigins(config: OriginConfig): string[] {
  const origins = [`http://localhost:${config.port}`];
  if (config.siteUrl) origins.unshift(new URL(config.siteUrl).origin);
  return origins;
}

/** The request's origin when it is one of the allowed origins, else `null` (answer `403 insecure_origin`). */
export function allowedOrigin(req: OriginRequest, config: OriginConfig): string | null {
  const origin = requestOrigin(req);
  return origin !== null && allowedOrigins(config).includes(origin) ? origin : null;
}

/** The OAuth redirect URL for an allowed origin: fixed per origin, never built from request headers. */
export function oauthRedirectUrl(origin: string, config: OriginConfig): string {
  const known = allowedOrigins(config).find((o) => o === origin);
  if (!known) throw new Error('Not an allowed origin.');
  return `${known}/auth/discord`;
}
