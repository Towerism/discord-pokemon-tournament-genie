import { describe, expect, it } from 'vitest';
import { fromBits, toBits } from '../../src/io/rest.js';
import { PERMISSIONS } from '../../src/s3/types.js';
import { INVITE_PERMISSIONS } from '../../src/s3/preflight.js';

// The harness speaks discord.js flag names end to end; a misspelt name would silently drop a
// permission from an overwrite, so every name the catalog uses must round-trip.
describe('permission names ↔ bitfields', () => {
  it.each([...PERMISSIONS, ...INVITE_PERMISSIONS, 'ManageChannels', 'ManageRoles', 'AttachFiles', 'MentionEveryone', 'Administrator'])(
    '%s round-trips',
    (name) => {
      expect(fromBits(toBits([name]))).toEqual([name]);
    },
  );

  it('round-trips a set', () => {
    expect(fromBits(toBits([...INVITE_PERMISSIONS]))).toEqual([...INVITE_PERMISSIONS].sort());
  });
});
