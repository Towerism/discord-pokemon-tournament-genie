import { describe, expect, it } from 'vitest';
import { baseOverwrites, STAFF_ALLOW } from '../../../shared/blueprints';
import { member, role } from '../../../shared/discord/overwrites';
import { PERMISSION_BITS as P } from '../../../shared/discord/permissions';
import { type AuditInput, privacyAudit } from './audit';

const GUILD = '400000000000000001';
const BOT = '300000000000000009';
const ORG = '200000000000000001';
const ADMIN_ROLE = '200000000000000009';
const U = (n: number) => `10000000000000000${n}`;
const base = baseOverwrites({ guildId: GUILD, botUserId: BOT, organizerRoleId: ORG });
const staff = (...users: string[]) => [...base, ...users.map((u) => member(u, { allow: STAFF_ALLOW }))];
const channel = (id: string, overwrites = base) => ({ id, type: 'text' as const, name: id, parentId: 'cat', topic: null, position: 0, overwrites });

function input(over: Partial<AuditInput> = {}): AuditInput {
  return {
    guild: {
      guildId: GUILD,
      ownerId: U(9),
      roles: [
        { id: GUILD, permissions: P.ViewChannel | P.SendMessages },
        { id: ORG, permissions: 0n },
        { id: ADMIN_ROLE, permissions: P.Administrator },
      ],
      members: [
        { userId: BOT, roleIds: [] },
        { userId: U(1), roleIds: [] },
        { userId: U(2), roleIds: [] },
        { userId: U(3), roleIds: [ORG] },
        { userId: U(4), roleIds: [ADMIN_ROLE, ORG] },
        { userId: U(9), roleIds: [] },
      ],
    },
    botUserId: BOT,
    organizerRoleId: ORG,
    category: channel('cat'),
    channels: [{ key: 'floor', eventId: 1, state: channel('c1', staff(U(1))), audienceUserIds: [U(1)] }],
    orphans: [],
    ...over,
  };
}

describe('privacyAudit', () => {
  it('passes when exactly the audience can view, counting administrators, the owner and organizers apart', () => {
    const result = privacyAudit(input());
    expect(result.failures).toEqual([]);
    // U(4) is both: counted once, as an administrator; U(9) owns the guild.
    expect(result.alsoVisible).toEqual({ administrators: 2, organizers: 1 });
  });

  it('fails a viewer outside the audience', () => {
    const result = privacyAudit(input({ channels: [{ key: 'floor', eventId: 1, state: channel('c1', staff(U(1), U(2))), audienceUserIds: [U(1)] }] }));
    expect(result.failures).toEqual([{ key: 'floor', eventId: 1, channelId: 'c1', name: 'c1', extra: [U(2)], missing: [] }]);
  });

  it('fails an audience member who can’t view', () => {
    const result = privacyAudit(input({ channels: [{ key: 'floor', eventId: 1, state: channel('c1'), audienceUserIds: [U(1)] }] }));
    expect(result.failures).toEqual([{ key: 'floor', eventId: 1, channelId: 'c1', name: 'c1', extra: [], missing: [U(1)] }]);
  });

  it('fails a channel with no @everyone deny, which the whole guild can view', () => {
    const open = channel('c1', [member(BOT, { allow: P.ViewChannel }), member(U(1), { allow: STAFF_ALLOW })]);
    const result = privacyAudit(input({ channels: [{ key: 'floor', eventId: 1, state: open, audienceUserIds: [U(1)] }] }));
    expect(result.failures[0]?.extra).toEqual([U(2)]);
  });

  it('ignores an audience member who left the guild', () => {
    const result = privacyAudit(input({ channels: [{ key: 'floor', eventId: 1, state: channel('c1', staff(U(1), U(7))), audienceUserIds: [U(1), U(7)] }] }));
    expect(result.failures).toEqual([]);
  });

  it('audits the category against an empty audience', () => {
    const result = privacyAudit(input({ category: channel('cat', [...base, member(U(2), { allow: P.ViewChannel })]) }));
    expect(result.failures).toEqual([{ key: 'category', eventId: null, channelId: 'cat', name: 'cat', extra: [U(2)], missing: [] }]);
  });

  it('reports, never fails, viewers of an orphan', () => {
    const result = privacyAudit(input({ orphans: [channel('o1', [member(U(2), { allow: P.ViewChannel })])] }));
    expect(result.failures).toEqual([]);
    expect(result.orphanViewers).toEqual([{ channelId: 'o1', name: 'o1', users: [U(1), U(2)] }]);
  });

  it('keeps organizer-role holders out of the comparison even when the organizer role overwrite is missing', () => {
    const noOrg = channel('c1', [...staff(U(1)).filter((o) => o.target.kind !== 'role'), role('x', { allow: 0n })]);
    const result = privacyAudit(input({ channels: [{ key: 'floor', eventId: 1, state: noOrg, audienceUserIds: [U(1)] }] }));
    expect(result.failures).toEqual([]);
  });
});
