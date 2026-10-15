import { describe, expect, it } from 'vitest';
import { type Overwrite, everyone, member, role } from './overwrites';
import { PERMISSION_BITS as P, bitsOf } from './permissions';
import { type ResolveInput, can, effectivePermissions } from './resolve';

const GUILD = '400000000000000001';
const BASE = bitsOf(['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions']);

function input(over: Partial<ResolveInput> & { overwrites?: Overwrite[] } = {}): ResolveInput {
  const { overwrites = [], ...rest } = over;
  return {
    guildId: GUILD,
    guildOwnerId: 'owner',
    roles: [{ id: GUILD, permissions: BASE }],
    member: { userId: 'u1', roleIds: [] },
    channel: { overwrites },
    ...rest,
  };
}

describe('effectivePermissions (Discord resolution order, §4.1 + ADR-0012)', () => {
  it('gives a member their own allows on a channel that hides it from @everyone', () => {
    const bits = effectivePermissions(
      input({
        overwrites: [everyone(GUILD, { deny: P.ViewChannel }), member('u1', { allow: bitsOf(['ViewChannel', 'SendMessages', 'ReadMessageHistory']) })],
      }),
    );
    expect(can(bits, 'ViewChannel')).toBe(true);
    expect(can(bits, 'SendMessages')).toBe(true);
    expect(can(bits, 'ReadMessageHistory')).toBe(true);
  });

  it('leaves nothing, not even base Send, once View is gone', () => {
    const bits = effectivePermissions(input({ overwrites: [everyone(GUILD, { deny: P.ViewChannel })] }));
    expect(bits).toBe(0n);
  });

  it('gives the guild owner every bit whatever the overwrites', () => {
    const bits = effectivePermissions(
      input({ member: { userId: 'owner', roleIds: [] }, overwrites: [everyone(GUILD, { deny: P.ViewChannel | P.SendMessages })] }),
    );
    expect(can(bits, 'ViewChannel')).toBe(true);
    expect(can(bits, 'SendMessages')).toBe(true);
    expect(can(bits, 'ManageRoles')).toBe(true);
  });

  it('gives an Administrator role holder every bit whatever the overwrites', () => {
    const bits = effectivePermissions(
      input({
        roles: [
          { id: GUILD, permissions: 0n },
          { id: 'admin', permissions: P.Administrator },
        ],
        member: { userId: 'u1', roleIds: ['admin'] },
        overwrites: [everyone(GUILD, { deny: P.ViewChannel }), member('u1', { deny: P.SendMessages })],
      }),
    );
    expect(can(bits, 'ViewChannel')).toBe(true);
    expect(can(bits, 'SendMessages')).toBe(true);
  });

  it('lets the member overwrite allow win over a role overwrite deny', () => {
    const bits = effectivePermissions(
      input({
        roles: [
          { id: GUILD, permissions: BASE },
          { id: 'r1', permissions: 0n },
        ],
        member: { userId: 'u1', roleIds: ['r1'] },
        overwrites: [role('r1', { deny: P.SendMessages }), member('u1', { allow: P.SendMessages })],
      }),
    );
    expect(can(bits, 'SendMessages')).toBe(true);
  });

  it('lets the member overwrite deny win over a role grant of the base', () => {
    const bits = effectivePermissions(
      input({
        roles: [
          { id: GUILD, permissions: P.ViewChannel },
          { id: 'sender', permissions: P.SendMessages },
        ],
        member: { userId: 'u1', roleIds: ['sender'] },
        overwrites: [member('u1', { deny: P.SendMessages })],
      }),
    );
    expect(can(bits, 'ViewChannel')).toBe(true);
    expect(can(bits, 'SendMessages')).toBe(false);
  });

  it('combines role overwrites with allows beating denies', () => {
    const bits = effectivePermissions(
      input({
        roles: [
          { id: GUILD, permissions: P.ViewChannel },
          { id: 'r1', permissions: 0n },
          { id: 'r2', permissions: 0n },
        ],
        member: { userId: 'u1', roleIds: ['r1', 'r2'] },
        overwrites: [role('r1', { allow: P.SendMessages }), role('r2', { deny: P.SendMessages })],
      }),
    );
    expect(can(bits, 'SendMessages')).toBe(true);
  });

  it('applies the @everyone overwrite before role overwrites', () => {
    const bits = effectivePermissions(
      input({
        roles: [
          { id: GUILD, permissions: BASE },
          { id: 'org', permissions: 0n },
        ],
        member: { userId: 'u1', roleIds: ['org'] },
        overwrites: [everyone(GUILD, { deny: P.ViewChannel }), role('org', { allow: P.ViewChannel })],
      }),
    );
    expect(can(bits, 'ViewChannel')).toBe(true);
    expect(can(bits, 'SendMessages')).toBe(true);
  });

  it('ignores role overwrites for roles the member lacks and other members’ overwrites', () => {
    const bits = effectivePermissions(
      input({
        overwrites: [everyone(GUILD, { deny: P.ViewChannel }), role('other-role', { allow: P.ViewChannel }), member('u2', { allow: P.ViewChannel })],
      }),
    );
    expect(bits).toBe(0n);
  });

  it('resolves guild-level permissions when there is no channel', () => {
    expect(effectivePermissions(input({ channel: null }))).toBe(BASE);
  });

  describe('threads', () => {
    const open = [member('u1', { allow: P.ViewChannel })];

    it('hides a private thread the member is not in', () => {
      const bits = effectivePermissions(input({ overwrites: open, thread: { type: 'private', archived: false, memberIds: ['u2'] } }));
      expect(bits).toBe(0n);
    });

    it('shows a private thread the member is in', () => {
      const bits = effectivePermissions(input({ overwrites: open, thread: { type: 'private', archived: false, memberIds: ['u1'] } }));
      expect(can(bits, 'ViewChannel')).toBe(true);
    });

    it('shows a private thread to a member with Manage Threads in the channel', () => {
      const bits = effectivePermissions(
        input({ overwrites: [member('u1', { allow: P.ViewChannel | P.ManageThreads })], thread: { type: 'private', archived: false, memberIds: [] } }),
      );
      expect(can(bits, 'ViewChannel')).toBe(true);
    });

    it('hides a public thread in a channel the member cannot view', () => {
      const bits = effectivePermissions(
        input({ overwrites: [everyone(GUILD, { deny: P.ViewChannel })], thread: { type: 'public', archived: false, memberIds: [] } }),
      );
      expect(bits).toBe(0n);
    });
  });
});
