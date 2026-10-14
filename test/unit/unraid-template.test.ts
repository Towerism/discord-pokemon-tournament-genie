import { readFileSync } from 'node:fs';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

// Genie's own checks until the kit's checkUnraidTemplate (selfhost-kit #19) is published (architecture §14).
const xml = readFileSync('deploy/unraid/tournament-genie.xml', 'utf8');

interface Config {
  Name: string;
  Target: string;
  Default: string;
  Type: 'Port' | 'Path' | 'Variable' | 'Label' | 'Device';
  Display: string;
  Required: 'true' | 'false';
  Mask: 'true' | 'false';
  value?: string;
}
const container = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: 'value', parseTagValue: false }).parse(xml)
  .Container as Record<string, unknown> & { Config: Config[] };
const config = (target: string) => {
  const found = container.Config.find((c) => c.Target === target);
  if (!found) throw new Error(`no Config with Target=${target}`);
  return found;
};

describe('the Unraid template', () => {
  it('has no required field (install is Add Container → Apply)', () => {
    expect(container.Config.filter((c) => c.Required !== 'false').map((c) => c.Name)).toEqual([]);
  });

  it('pulls the image the release publishes', () => {
    expect(container.Repository).toBe('ghcr.io/towerism/discord-pokemon-tournament-genie:latest');
  });

  it('publishes port 3001 only on the host loopback, never to the LAN (ADR-0013)', () => {
    expect(container.Config.filter((c) => c.Type === 'Port')).toEqual([]);
    expect(String(container.ExtraParams)).toContain('-p 127.0.0.1:3001:3001');
    expect(String(container.ExtraParams)).not.toMatch(/-p\s+(0\.0\.0\.0:)?3001/);
    expect(container.WebUI ?? '').toBe('');
  });

  it('keeps everything persistent in one appdata folder at /data', () => {
    const paths = container.Config.filter((c) => c.Type === 'Path');
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ Target: '/data', Default: '/mnt/user/appdata/tournament-genie', value: '/mnt/user/appdata/tournament-genie' });
  });

  it.each([
    ['PUID', '99'],
    ['PGID', '100'],
    ['UMASK', '022'],
  ])('defaults %s to %s', (name, value) => {
    expect(config(name)).toMatchObject({ Default: value, value });
  });

  it.each(['NUXT_SESSION_PASSWORD', 'NUXT_VAULT_KEY'])('offers %s only as an empty, masked, advanced override', (name) => {
    expect(config(name)).toMatchObject({ Display: 'advanced', Mask: 'true', Default: '' });
    expect(config(name).value ?? '').toBe('');
  });

  it('offers the site URL as an optional, visible field that is blank by default', () => {
    expect(config('NUXT_PUBLIC_SITE_URL')).toMatchObject({ Required: 'false', Default: '', Mask: 'false' });
  });

  it('offers the trusted proxies and the timezone as optional advanced fields', () => {
    expect(config('NUXT_TRUSTED_PROXIES')).toMatchObject({ Display: 'advanced', Default: '', Mask: 'false' });
    expect(config('TZ')).toMatchObject({ Required: 'false' });
  });

  it('never asks for Discord credentials', () => {
    expect(xml).not.toMatch(/BOT_TOKEN|CLIENT_SECRET|DISCORD_/);
  });

  it('explains Caddy and the SSH tunnel in the overview', () => {
    expect(String(container.Overview)).toContain('Caddy');
    expect(String(container.Overview)).toContain('ssh -L 3001:127.0.0.1:3001');
  });
});
