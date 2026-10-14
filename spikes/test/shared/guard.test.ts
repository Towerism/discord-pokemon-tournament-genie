import { describe, expect, it } from 'vitest';
import { guard } from '../../src/shared/guard.js';

const guildId = '1300000000000000001';

describe('guard', () => {
  it.each([
    ['genie-spike-test', true],
    ['Genie-Spike lab', true],
    ['GENIE-SPIKE', true],
  ])('allows the configured guild named %s', (name, ok) => {
    expect(guard({ id: guildId, name }, guildId).ok).toBe(ok);
  });

  it('refuses a matching ID whose name is not marked', () => {
    expect(guard({ id: guildId, name: 'Store Server' }, guildId)).toEqual({ ok: false, reason: 'guild_not_marked' });
  });

  it('refuses a marked guild whose ID differs from the configured one', () => {
    expect(guard({ id: '1300000000000000009', name: 'genie-spike-test' }, guildId)).toEqual({
      ok: false,
      reason: 'guild_mismatch',
    });
  });

  it('refuses a name that only contains the marker later on', () => {
    expect(guard({ id: guildId, name: 'my genie-spike' }, guildId)).toEqual({ ok: false, reason: 'guild_not_marked' });
  });
});
