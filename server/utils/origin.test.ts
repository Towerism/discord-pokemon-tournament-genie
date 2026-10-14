import { parseTrustedProxies } from '@towerism/selfhost-kit';
import { describe, expect, it } from 'vitest';
import { type OriginRequest, allowedOrigin, oauthRedirectUrl } from './origin';

const trusted = parseTrustedProxies('');
const site = { siteUrl: 'https://genie.example', port: 3001 };
const local = { siteUrl: '', port: 3001 };

const req = (over: Partial<OriginRequest> = {}): OriginRequest => ({
  remoteAddress: '127.0.0.1',
  host: 'localhost:3001',
  trusted,
  ...over,
});
const caddy = (over: Partial<OriginRequest> = {}) =>
  req({ remoteAddress: '172.18.0.5', host: 'genie.example', forwardedProto: 'https', ...over });

describe('allowedOrigin', () => {
  it('accepts the site URL through Caddy (a trusted peer forwarding https)', () => {
    expect(allowedOrigin(caddy(), site)).toBe('https://genie.example');
    expect(allowedOrigin(caddy({ host: 'internal:3001', forwardedHost: 'genie.example' }), site)).toBe(
      'https://genie.example',
    );
  });

  it('accepts localhost on the listening port, with or without a site URL', () => {
    expect(allowedOrigin(req(), site)).toBe('http://localhost:3001');
    expect(allowedOrigin(req(), local)).toBe('http://localhost:3001');
  });

  it('refuses a LAN address, another port, and a host the site does not serve', () => {
    expect(allowedOrigin(req({ remoteAddress: '192.168.1.20', host: '192.168.1.5:3001' }), site)).toBeNull();
    expect(allowedOrigin(req({ host: 'localhost:9999' }), site)).toBeNull();
    expect(allowedOrigin(req({ host: '127.0.0.1:3001' }), site)).toBeNull();
    expect(allowedOrigin(caddy({ host: 'evil.example' }), site)).toBeNull();
  });

  it('ignores forwarded headers from a peer that is not a trusted proxy', () => {
    const spoofed = req({ remoteAddress: '203.0.113.9', host: 'genie.example', forwardedProto: 'https' });
    expect(allowedOrigin(spoofed, site)).toBeNull();
    const spoofedLocal = req({ remoteAddress: '203.0.113.9', forwardedHost: 'genie.example', forwardedProto: 'https' });
    expect(allowedOrigin(spoofedLocal, site)).toBe('http://localhost:3001');
  });

  it('refuses the site URL without https, and when no site URL is configured', () => {
    expect(allowedOrigin(caddy({ forwardedProto: 'http' }), site)).toBeNull();
    expect(allowedOrigin(caddy(), local)).toBeNull();
  });

  it('refuses ambiguous or missing forwarded values and hosts', () => {
    expect(allowedOrigin(caddy({ forwardedProto: 'https, http' }), site)).toBeNull();
    expect(allowedOrigin(req({ host: undefined }), site)).toBeNull();
    expect(allowedOrigin(req({ host: 'local host' }), site)).toBeNull();
  });

  it('treats the default https port and host case as the same origin', () => {
    expect(allowedOrigin(caddy({ host: 'GENIE.example:443' }), site)).toBe('https://genie.example');
  });
});

describe('oauthRedirectUrl', () => {
  it('pins the redirect to the allowed origin it came from, never the request', () => {
    expect(oauthRedirectUrl('https://genie.example', site)).toBe('https://genie.example/auth/discord');
    expect(oauthRedirectUrl('http://localhost:3001', site)).toBe('http://localhost:3001/auth/discord');
  });
});
