import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  classifySetup,
  escapeHtml,
  handleCallback,
  stateCookie,
  type OAuthDeps,
} from '../../src/s1/oauth.js';

const clientId = '1300000000000000002';
const redirectUri = 'http://192.168.1.20:3001/auth/discord';
const fixedState = 'a'.repeat(64);

function deps(over: Partial<OAuthDeps> = {}): OAuthDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    clientId,
    clientSecret: 'shhh-secret-value',
    redirectUri,
    cookieMode: 'secure',
    now: () => new Date('2026-10-13T12:00:00Z'),
    fetch: async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'at-123', token_type: 'Bearer' }), { status: 200 });
      return new Response(JSON.stringify({ id: '1', username: 'judge', global_name: '<b>Judge</b>' }), { status: 200 });
    },
    ...over,
  };
}

describe('authorizeUrl', () => {
  it('asks for identify with the given redirect and state', () => {
    const url = new URL(authorizeUrl({ clientId, redirectUri, state: fixedState }));
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: clientId,
      scope: 'identify',
      redirect_uri: redirectUri,
      state: fixedState,
    });
  });
});

describe('stateCookie', () => {
  it('is HttpOnly and SameSite=Lax, and Secure unless insecure mode is chosen', () => {
    expect(stateCookie(fixedState, 'secure')).toBe(`s1_state=${fixedState}; HttpOnly; SameSite=Lax; Path=/; Secure`);
    expect(stateCookie(fixedState, 'insecure')).toBe(`s1_state=${fixedState}; HttpOnly; SameSite=Lax; Path=/`);
  });
});

describe('handleCallback', () => {
  it('refuses a mismatched state without exchanging the code', async () => {
    const d = deps();
    const r = await handleCallback({ code: 'c0de', state: 'b'.repeat(64) }, `s1_state=${fixedState}`, d);
    expect(r.attempt.outcome).toBe('state_mismatch');
    expect(d.calls).toEqual([]);
    expect(r.status).toBe(400);
  });

  it('reports a missing state cookie (dropped Secure cookie over plain HTTP)', async () => {
    const d = deps();
    const r = await handleCallback({ code: 'c0de', state: fixedState }, undefined, d);
    expect(r.attempt.outcome).toBe('state_cookie_missing');
    expect(d.calls).toEqual([]);
  });

  it('completes a round-trip and records no code, token or secret', async () => {
    const d = deps();
    const r = await handleCallback({ code: 'c0de-value', state: fixedState }, `other=1; s1_state=${fixedState}`, d);
    expect(r.status).toBe(200);
    expect(r.attempt).toEqual({
      at: '2026-10-13T12:00:00.000Z',
      redirectUri,
      setup: 'lan-ip',
      cookieMode: 'secure',
      outcome: 'ok',
    });
    const recorded = JSON.stringify(r.attempt);
    expect(recorded).not.toContain('c0de-value');
    expect(recorded).not.toContain('at-123');
    expect(recorded).not.toContain('shhh-secret-value');
  });

  it('HTML-escapes the username it shows', async () => {
    const r = await handleCallback({ code: 'c', state: fixedState }, `s1_state=${fixedState}`, deps());
    expect(r.html).toContain('&lt;b&gt;Judge&lt;/b&gt;');
    expect(r.html).not.toContain('<b>Judge</b>');
  });

  it('records a failed exchange with Discord\'s error field only', async () => {
    const d = deps({
      fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid "redirect_uri" in request.' }), { status: 400 }),
    });
    const r = await handleCallback({ code: 'c', state: fixedState }, `s1_state=${fixedState}`, d);
    expect(r.attempt).toMatchObject({ outcome: 'token_exchange_failed', discordError: 'invalid_grant' });
  });

  it('records a failed user fetch', async () => {
    const d = deps({
      fetch: async (url) =>
        String(url).endsWith('/oauth2/token')
          ? new Response(JSON.stringify({ access_token: 'x' }), { status: 200 })
          : new Response('{}', { status: 401 }),
    });
    expect((await handleCallback({ code: 'c', state: fixedState }, `s1_state=${fixedState}`, d)).attempt.outcome).toBe('user_fetch_failed');
  });

  it('sends the code exchange form-encoded with the same redirect URI', async () => {
    let body = '';
    const d = deps({
      fetch: async (url, init) => {
        if (String(url).endsWith('/oauth2/token')) {
          body = String(init?.body);
          return new Response(JSON.stringify({ access_token: 'x' }), { status: 200 });
        }
        return new Response(JSON.stringify({ username: 'j' }), { status: 200 });
      },
    });
    await handleCallback({ code: 'c', state: fixedState }, `s1_state=${fixedState}`, d);
    expect(Object.fromEntries(new URLSearchParams(body))).toMatchObject({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: redirectUri,
    });
  });
});

describe('classifySetup', () => {
  it.each([
    ['http://localhost:3001/auth/discord', 'localhost'],
    ['http://127.0.0.1:3001/auth/discord', 'localhost'],
    ['http://192.168.1.20:3001/auth/discord', 'lan-ip'],
    ['http://10.0.0.5:3001/x', 'lan-ip'],
    ['http://tower.local:3001/x', 'mdns'],
    ['http://tower:3001/x', 'magicdns-http'],
    ['https://tower.tail1234.ts.net/x', 'tailscale-serve'],
    ['https://genie.example.com/x', 'reverse-proxy'],
    ['http://genie.example.com/x', 'other'],
  ])('%s → %s', (uri, setup) => {
    expect(classifySetup(uri)).toBe(setup);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
