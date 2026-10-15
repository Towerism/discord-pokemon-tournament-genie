import { InvalidConfigError } from '@towerism/selfhost-kit';
import { type TempSecretsDir, tempSecretsDir } from '@towerism/selfhost-kit/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareGenieEnv } from './env';

let dir: TempSecretsDir;
beforeEach(() => {
  dir = tempSecretsDir();
});
afterEach(() => dir.cleanup());

const prepare = (env: Record<string, string | undefined> = {}) =>
  prepareGenieEnv({ NUXT_DATABASE_PATH: dir.databasePath, ...env });

describe('prepareGenieEnv', () => {
  it('generates the session password and vault key, and logs where they came from but not their values', () => {
    const { env, log } = prepare();
    expect(env.NUXT_SESSION_PASSWORD).toMatch(/^.{32,}$/);
    expect(Buffer.from(env.NUXT_VAULT_KEY!, 'base64')).toHaveLength(32);
    const joined = log.join('\n');
    expect(joined).toContain('vault.key');
    expect(joined).not.toContain(env.NUXT_VAULT_KEY);
    expect(joined).not.toContain(env.NUXT_SESSION_PASSWORD);
  });

  it('forces Secure session cookies, whatever the input says', () => {
    expect(prepare().env.NUXT_SESSION_COOKIE_SECURE).toBe('true');
    expect(prepare({ NUXT_SESSION_COOKIE_SECURE: 'false' }).env.NUXT_SESSION_COOKIE_SECURE).toBe('true');
  });

  it('listens on 3001 unless a port is given', () => {
    expect(prepare().env.PORT).toBe('3001');
    expect(prepare({ PORT: '4000' }).env.PORT).toBe('4000');
    expect(prepare({ NITRO_PORT: '4001' }).env.PORT).toBeUndefined();
  });

  it.each(['http://genie.example', 'https://genie.example/path', 'https://genie.example?x=1', 'https://genie.example#a', 'not a url', 'https://user@genie.example'])(
    'refuses NUXT_PUBLIC_SITE_URL=%s',
    (siteUrl) => {
      expect(() => prepare({ NUXT_PUBLIC_SITE_URL: siteUrl })).toThrow(InvalidConfigError);
      expect(() => prepare({ NUXT_PUBLIC_SITE_URL: siteUrl })).toThrow(/NUXT_PUBLIC_SITE_URL/);
    },
  );

  it.each(['https://genie.example', 'https://genie.example:8443', 'https://genie.example/', ''])(
    'accepts NUXT_PUBLIC_SITE_URL=%s',
    (siteUrl) => {
      expect(() => prepare({ NUXT_PUBLIC_SITE_URL: siteUrl })).not.toThrow();
    },
  );

  it('refuses rate-limit tuning that is not a whole number of at least 1, and drops blank values', () => {
    expect(() => prepare({ NUXT_AUTH_RATE_LIMIT_LOGIN_MAX: '0' })).toThrow(InvalidConfigError);
    expect(prepare({ NUXT_AUTH_RATE_LIMIT_SETUP_MAX: ' ' }).env).not.toHaveProperty('NUXT_AUTH_RATE_LIMIT_SETUP_MAX');
    expect(prepare({ NUXT_AUTH_RATE_LIMIT_SETUP_MAX: '20' }).env.NUXT_AUTH_RATE_LIMIT_SETUP_MAX).toBe('20');
  });
});

describe('the store time zone', () => {
  // Unraid passes a blank Timezone field as TZ="", which Node resolves to ICU's unusable Etc/Unknown.
  it.each([undefined, '', '   '])('defaults TZ=%j to Central time, and says so in the log', (tz) => {
    const { env, log } = prepare({ TZ: tz });
    expect(env.TZ).toBe('America/Chicago');
    expect(log).toContain('Store time zone: America/Chicago (default; set TZ to change it)');
  });

  it.each([
    ['America/Chicago', 'America/Chicago'],
    ['US/Central', 'US/Central'],
    ['UTC', 'UTC'],
    [' Europe/London ', 'Europe/London'],
  ])('keeps TZ=%j as %s', (tz, kept) => {
    const { env, log } = prepare({ TZ: tz });
    expect(env.TZ).toBe(kept);
    expect(log).toContain(`Store time zone: ${kept} (from TZ)`);
  });

  it.each(['America/Chicgo', 'Etc/Unknown', 'CST6CDT,M3.2.0,M11.1.0', ':/etc/localtime'])('refuses TZ=%s, naming it', (tz) => {
    expect(() => prepare({ TZ: tz })).toThrow(InvalidConfigError);
    expect(() => prepare({ TZ: tz })).toThrow(`TZ must be an IANA time zone like America/Chicago (got ${JSON.stringify(tz)})`);
  });

  it('quotes a refused TZ, so it stays on one log line', () => {
    expect(() => prepare({ TZ: 'Bad\nZone' })).toThrow(/^[^\n]*"Bad\\nZone"[^\n]*$/);
  });
});
