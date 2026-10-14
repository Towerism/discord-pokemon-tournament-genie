import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/shared/config.js';

const token = (seed: string) => `MTI${seed.padEnd(23, 'x')}.Gabcde.${'y'.repeat(30)}`;

const fullEnv = {
  GENIE_SPIKE_GUILD_ID: '1300000000000000001',
  GENIE_SPIKE_ARRANGER_TOKEN: token('arranger'),
  GENIE_SPIKE_GENIE_TOKEN: token('genie'),
  GENIE_SPIKE_GENIE_CLIENT_ID: '1300000000000000002',
  GENIE_SPIKE_GENIE_CLIENT_SECRET: 'sEcReTvalue_1234567890abcdef',
  GENIE_SPIKE_PROBE_A_TOKEN: token('probea'),
  GENIE_SPIKE_PROBE_B_TOKEN: token('probeb'),
};

describe('loadConfig', () => {
  it('accepts a complete environment', () => {
    const result = loadConfig(fullEnv);
    expect(result.ok).toBe(true);
  });

  it('names a missing variable and refuses', () => {
    const { GENIE_SPIKE_GENIE_TOKEN: _omit, ...env } = fullEnv;
    const result = loadConfig(env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('GENIE_SPIKE_GENIE_TOKEN');
  });

  it('names a malformed token without echoing its value', () => {
    const bad = 'not a token at all';
    const result = loadConfig({ ...fullEnv, GENIE_SPIKE_PROBE_A_TOKEN: bad });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('GENIE_SPIKE_PROBE_A_TOKEN');
    expect(result.message).not.toContain(bad);
  });

  it('rejects a guild ID that is not a snowflake', () => {
    const result = loadConfig({ ...fullEnv, GENIE_SPIKE_GUILD_ID: 'store' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('GENIE_SPIKE_GUILD_ID');
  });

  it('checks only the variables a command needs', () => {
    const result = loadConfig({ GENIE_SPIKE_GUILD_ID: fullEnv.GENIE_SPIKE_GUILD_ID, GENIE_SPIKE_GENIE_TOKEN: fullEnv.GENIE_SPIKE_GENIE_TOKEN }, [
      'GENIE_SPIKE_GUILD_ID',
      'GENIE_SPIKE_GENIE_TOKEN',
    ]);
    expect(result.ok).toBe(true);
  });

  it('lists the secret values so the redactor can mask them', () => {
    const result = loadConfig(fullEnv);
    if (!result.ok) throw new Error('expected ok');
    expect(result.secrets).toEqual(
      expect.arrayContaining([fullEnv.GENIE_SPIKE_GENIE_TOKEN, fullEnv.GENIE_SPIKE_GENIE_CLIENT_SECRET]),
    );
    expect(result.secrets).not.toContain(fullEnv.GENIE_SPIKE_GUILD_ID);
  });
});
