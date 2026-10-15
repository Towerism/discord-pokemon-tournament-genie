import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STAFF_ALLOW, baseOverwrites } from '../blueprints';
import { LOCK_SET, isLocked, lockedOverwrites } from './lock';
import { type Overwrite, everyone, member, overwritesEqual, role } from './overwrites';
import { PERMISSION_BITS as P } from './permissions';
import { can, effectivePermissions } from './resolve';

const SEED = 20261015;
const GUILD = '400000000000000001';
const BOT = '300000000000000009';
const OWNER = '100000000000000001';
const ORG_ROLE = '200000000000000001';
const ADMIN_ROLE = '200000000000000009';
const OTHER_ROLE = '200000000000000005';
const LOCK_NAMES = ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'] as const;

const base = baseOverwrites({ guildId: GUILD, botUserId: BOT, organizerRoleId: ORG_ROLE });

describe('lockedOverwrites', () => {
  it('denies the lock set to everyone but the bot and keeps the audience reading', () => {
    const desired = [...base, member('100000000000000101', { allow: STAFF_ALLOW })];
    const locked = lockedOverwrites(desired, BOT);
    const of = (o: Overwrite[], key: string) => o.find((x) => (x.target.kind === 'everyone' ? 'everyone' : x.target.id) === key)!;
    expect(of(locked, 'everyone').deny & LOCK_SET).toBe(LOCK_SET);
    expect(of(locked, 'everyone').deny & P.ViewChannel).toBe(P.ViewChannel);
    expect(of(locked, ORG_ROLE).deny & LOCK_SET).toBe(LOCK_SET);
    expect(of(locked, ORG_ROLE).allow).toBe(P.ViewChannel);
    const staff = of(locked, '100000000000000101');
    expect(staff.allow).toBe(STAFF_ALLOW & ~LOCK_SET);
    expect(staff.deny).toBe(LOCK_SET);
    expect(of(locked, BOT)).toEqual(of(desired, BOT));
  });

  it('adds an @everyone overwrite denying View and the lock set when there is none', () => {
    const locked = lockedOverwrites([member(BOT, { allow: P.ViewChannel }), member('100000000000000101', { allow: P.ViewChannel | P.SendMessages })], BOT);
    expect(locked.find((o) => o.target.kind === 'everyone')).toEqual(everyone(GUILD, { deny: P.ViewChannel | LOCK_SET }));
  });

  it('is idempotent, and tells a locked list from an open one', () => {
    const desired = [...base, member('100000000000000101', { allow: STAFF_ALLOW })];
    const once = lockedOverwrites(desired, BOT);
    expect(overwritesEqual(lockedOverwrites(once, BOT), once)).toBe(true);
    expect(isLocked(once, BOT)).toBe(true);
    expect(isLocked(desired, BOT)).toBe(false);
    expect(isLocked([], BOT)).toBe(false);
  });

  it('never leaves a lock permission to a non-bot, non-admin member, in any guild', () => {
    const bits = fc.constantFrom(0n, P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.AddReactions, P.CreatePublicThreads, P.CreatePrivateThreads, P.SendMessagesInThreads, P.ManageThreads);
    const perms = fc.array(bits, { maxLength: 6 }).map((xs) => xs.reduce((a, b) => a | b, 0n));
    const people = fc.array(
      fc.record({ roles: fc.subarray([ORG_ROLE, OTHER_ROLE, ADMIN_ROLE]), audience: fc.boolean(), inThread: fc.boolean() }),
      { minLength: 1, maxLength: 8 },
    );
    const world = fc.record({
      everyoneBase: perms,
      orgBase: perms,
      otherBase: perms,
      otherOverwrite: fc.option(fc.record({ allow: perms, deny: perms })),
      people,
      threadType: fc.constantFrom('public' as const, 'private' as const),
    });
    fc.assert(
      fc.property(world, (w) => {
        const roles = [
          { id: GUILD, permissions: w.everyoneBase },
          { id: ORG_ROLE, permissions: w.orgBase },
          { id: OTHER_ROLE, permissions: w.otherBase },
          { id: ADMIN_ROLE, permissions: P.Administrator },
        ];
        const userId = (i: number) => `1000000000000002${String(i).padStart(2, '0')}`;
        const audience = w.people.flatMap((p, i) => (p.audience ? [userId(i)] : []));
        const desired: Overwrite[] = [
          ...base,
          ...(w.otherOverwrite ? [role(OTHER_ROLE, w.otherOverwrite)] : []),
          ...audience.map((u) => member(u, { allow: STAFF_ALLOW })),
        ];
        const locked = lockedOverwrites(desired, BOT);
        const threadMembers = w.people.flatMap((p, i) => (p.inThread ? [userId(i)] : []));
        w.people.forEach((p, i) => {
          const m = { userId: userId(i), roleIds: p.roles };
          const input = { guildId: GUILD, guildOwnerId: OWNER, roles, member: m, channel: { overwrites: locked } };
          const before = effectivePermissions({ ...input, channel: { overwrites: desired } });
          const inChannel = effectivePermissions(input);
          const inThread = effectivePermissions({ ...input, thread: { type: w.threadType, archived: false, memberIds: threadMembers } });
          const admin = p.roles.includes(ADMIN_ROLE);
          if (!admin) {
            for (const name of LOCK_NAMES) {
              expect(can(inChannel, name)).toBe(false);
              expect(can(inThread, name)).toBe(false);
            }
            // The lock never widens who can see the channel.
            if (can(inChannel, 'ViewChannel')) expect(can(before, 'ViewChannel')).toBe(true);
          }
          if (audience.includes(m.userId)) {
            expect(can(inChannel, 'ViewChannel')).toBe(true);
            expect(can(inChannel, 'ReadMessageHistory')).toBe(true);
          }
          if (p.roles.includes(ORG_ROLE) && !admin && can(before, 'ViewChannel')) {
            expect(can(inChannel, 'ViewChannel')).toBe(true);
            if (can(before, 'ReadMessageHistory')) expect(can(inChannel, 'ReadMessageHistory')).toBe(true);
          }
        });
        const bot = (o: Overwrite[]) => o.find((x) => x.target.kind === 'member' && x.target.id === BOT);
        expect(bot(locked)).toEqual(bot(desired));
        expect(overwritesEqual(lockedOverwrites(locked, BOT), locked)).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
