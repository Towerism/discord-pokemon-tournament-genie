export type CookieMode = 'secure' | 'insecure';
export type S1Setup = 'localhost' | 'lan-ip' | 'mdns' | 'magicdns-http' | 'tailscale-serve' | 'reverse-proxy' | 'other';
export type S1Outcome =
  | 'ok'
  | 'portal_rejected'
  | 'authorize_rejected'
  | 'state_cookie_missing'
  | 'state_mismatch'
  | 'token_exchange_failed'
  | 'user_fetch_failed';

/** One line of `spikes/out/s1-attempts.jsonl`. Never holds the code, a token or the secret (FR-9). */
export type S1Attempt = {
  at: string;
  redirectUri: string;
  setup: S1Setup;
  cookieMode: CookieMode;
  outcome: S1Outcome;
  discordError?: string;
};

export const API = 'https://discord.com/api/v10';
export const COOKIE = 's1_state';

export function authorizeUrl(p: { clientId: string; redirectUri: string; state: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: p.clientId,
    scope: 'identify',
    redirect_uri: p.redirectUri,
    state: p.state,
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

export function stateCookie(state: string, mode: CookieMode): string {
  return `${COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/${mode === 'secure' ? '; Secure' : ''}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export function classifySetup(uri: string): S1Setup {
  const u = new URL(uri);
  const host = u.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'localhost';
  if (PRIVATE_V4.test(host)) return 'lan-ip';
  if (host.endsWith('.local')) return 'mdns';
  if (host.endsWith('.ts.net') && u.protocol === 'https:') return 'tailscale-serve';
  if (!host.includes('.') && u.protocol === 'http:') return 'magicdns-http';
  if (u.protocol === 'https:') return 'reverse-proxy';
  return 'other';
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

export type OAuthDeps = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  cookieMode: CookieMode;
  now: () => Date;
  fetch: typeof fetch;
};

export type CallbackResult = { status: number; html: string; attempt: S1Attempt };

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><p>${body}</p>`;

/** Handles `GET <redirect path>?code&state`: state check, code exchange, `/users/@me`. */
export async function handleCallback(
  query: { code?: string; state?: string },
  cookieHeader: string | undefined,
  d: OAuthDeps,
): Promise<CallbackResult> {
  const base = { at: d.now().toISOString(), redirectUri: d.redirectUri, setup: classifySetup(d.redirectUri), cookieMode: d.cookieMode };
  const fail = (outcome: S1Outcome, discordError?: string): CallbackResult => ({
    status: 400,
    html: page('S1 failed', `Outcome: ${escapeHtml(outcome)}${discordError ? ` (${escapeHtml(discordError)})` : ''}`),
    attempt: { ...base, outcome, ...(discordError ? { discordError } : {}) },
  });

  const cookieState = readCookie(cookieHeader, COOKIE);
  if (!cookieState) return fail('state_cookie_missing');
  if (!query.state || query.state !== cookieState) return fail('state_mismatch');

  const tokenRes = await d.fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: query.code ?? '',
      redirect_uri: d.redirectUri,
      client_id: d.clientId,
      client_secret: d.clientSecret,
    }).toString(),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenBody.access_token) return fail('token_exchange_failed', tokenBody.error ?? `http_${tokenRes.status}`);

  const userRes = await d.fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${tokenBody.access_token}` } });
  if (!userRes.ok) return fail('user_fetch_failed', `http_${userRes.status}`);
  const user = (await userRes.json()) as { username?: string; global_name?: string | null };
  const name = user.global_name ?? user.username ?? '(unknown)';
  return { status: 200, html: page('S1 ok', `Logged in as ${escapeHtml(name)}`), attempt: { ...base, outcome: 'ok' } };
}
