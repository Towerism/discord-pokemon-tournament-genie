import { describe, expect, it } from 'vitest';
import { overwrite } from '../../src/s3/profiles.js';
import { resolve, sameOverwrites, unresolve, type Ids } from '../../src/s3/resolve.js';

const ids: Ids = {
  guildId: '1300000000000000001',
  roles: { 'role:organizer': '1300000000000000010' },
  members: { 'member:subject': '1300000000000000020', 'member:other': '1300000000000000021', 'member:genie': '1300000000000000022' },
};

describe('resolve / unresolve', () => {
  const symbolic = [
    overwrite('everyone', { deny: ['ViewChannel'] }),
    overwrite('member:genie', { allow: ['ViewChannel', 'SendMessages'], allowOther: ['ManageChannels', 'ManageRoles'] }),
    overwrite('role:organizer', { allow: ['ViewChannel'] }),
  ];

  it('resolves symbolic targets to IDs, @everyone being the guild ID', () => {
    const r = resolve(symbolic, ids);
    expect(r[0]).toEqual({ id: ids.guildId, type: 'role', allow: [], deny: ['ViewChannel'] });
    expect(r[1]).toEqual({
      id: ids.members['member:genie'],
      type: 'member',
      allow: ['ManageChannels', 'ManageRoles', 'SendMessages', 'ViewChannel'],
      deny: [],
    });
  });

  it('round-trips, splitting modelled and other permissions', () => {
    expect(sameOverwrites(unresolve(resolve(symbolic, ids), ids), symbolic)).toBe(true);
    expect(unresolve(resolve(symbolic, ids), ids)[1]!.allowOther).toEqual(['ManageChannels', 'ManageRoles']);
  });

  it('never leaks an unknown snowflake into a symbolic overwrite', () => {
    const back = unresolve([{ id: '1300000000000000999', type: 'member', allow: ['ViewChannel'], deny: [] }], ids);
    expect(back[0]!.target).toBe('member:unknown');
  });

  it('refuses to resolve a target it has no ID for', () => {
    expect(() => resolve([overwrite('role:missing', { allow: ['ViewChannel'] })], ids)).toThrow(/role:missing/);
  });

  it('compares overwrite lists regardless of order', () => {
    expect(sameOverwrites([...symbolic].reverse(), symbolic)).toBe(true);
    expect(sameOverwrites(symbolic.slice(1), symbolic)).toBe(false);
    const changed = [symbolic[0]!, { ...symbolic[1]!, allowOther: ['ManageChannels'] }, symbolic[2]!];
    expect(sameOverwrites(changed, symbolic)).toBe(false);
  });
});
