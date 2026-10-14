import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Grant, canSee, decideAccess } from './access';

const OWNER = '100000000000000001';
const USER = '100000000000000002';
const ORGANIZER_ROLE = '200000000000000001';
const OTHER_ROLE = '200000000000000002';

const input = (over: Partial<Parameters<typeof decideAccess>[0]> = {}): Parameters<typeof decideAccess>[0] => ({
  userId: USER,
  member: { userId: USER, roleIds: [] },
  ownerId: OWNER,
  organizerRoleId: ORGANIZER_ROLE,
  allowlist: { enabled: false, userIds: [] },
  ...over,
});

describe('decideAccess', () => {
  it('refuses anyone who is not a member of the bound guild, the owner included', () => {
    expect(decideAccess(input({ member: null }))).toEqual({ allowed: false, reason: 'not_in_guild' });
    expect(decideAccess(input({ userId: OWNER, member: null }))).toEqual({ allowed: false, reason: 'not_in_guild' });
  });

  it('admits the owner by ownership, whatever their roles or the allowlist', () => {
    const owner = { userId: OWNER, member: { userId: OWNER, roleIds: [] } };
    expect(decideAccess(input(owner))).toEqual({ allowed: true, grant: 'owner' });
    expect(decideAccess(input({ ...owner, allowlist: { enabled: true, userIds: [] } }))).toEqual({
      allowed: true,
      grant: 'owner',
    });
  });

  it('admits an organizer-role holder through the role while the allowlist is off', () => {
    const member = { userId: USER, roleIds: [OTHER_ROLE, ORGANIZER_ROLE] };
    expect(decideAccess(input({ member }))).toEqual({ allowed: true, grant: 'organizer_role' });
  });

  it('admits an organizer-role holder through the allowlist only when they are listed', () => {
    const member = { userId: USER, roleIds: [ORGANIZER_ROLE] };
    expect(decideAccess(input({ member, allowlist: { enabled: true, userIds: [USER] } }))).toEqual({
      allowed: true,
      grant: 'allowlist',
    });
    expect(decideAccess(input({ member, allowlist: { enabled: true, userIds: [] } }))).toEqual({
      allowed: false,
      reason: 'no_access',
    });
  });

  it('refuses a listed member who lacks the organizer role', () => {
    expect(decideAccess(input({ allowlist: { enabled: true, userIds: [USER] } }))).toEqual({
      allowed: false,
      reason: 'no_access',
    });
  });

  it('refuses a member with no organizer grant, and everyone but the owner while no role is mapped', () => {
    expect(decideAccess(input({ member: { userId: USER, roleIds: [OTHER_ROLE] } }))).toEqual({
      allowed: false,
      reason: 'no_access',
    });
    expect(
      decideAccess(input({ organizerRoleId: null, member: { userId: USER, roleIds: [ORGANIZER_ROLE] } })),
    ).toEqual({ allowed: false, reason: 'no_access' });
  });

  it('refuses a member with no grant while no owner is bound', () => {
    expect(decideAccess(input({ ownerId: null, userId: USER }))).toEqual({ allowed: false, reason: 'no_access' });
  });

  it('keeps its invariants over random members, roles, allowlists and owners', () => {
    const id = fc.constantFrom(OWNER, USER, '100000000000000003');
    const role = fc.constantFrom(ORGANIZER_ROLE, OTHER_ROLE);
    fc.assert(
      fc.property(
        id,
        fc.option(fc.uniqueArray(role), { nil: null }),
        fc.option(id, { nil: null }),
        fc.option(role, { nil: null }),
        fc.boolean(),
        fc.uniqueArray(id),
        (userId, roles, ownerId, organizerRoleId, enabled, userIds) => {
          const member = roles === null ? null : { userId, roleIds: roles };
          const result = decideAccess({ userId, member, ownerId, organizerRoleId, allowlist: { enabled, userIds } });
          if (!result.allowed) return;
          expect(member).not.toBeNull();
          if (result.grant === 'allowlist') {
            expect(enabled).toBe(true);
            expect(userIds).toContain(userId);
          }
          if (enabled && result.grant !== 'owner') expect(userIds).toContain(userId);
          if (result.grant === 'owner') expect(userId).toBe(ownerId);
        },
      ),
      { seed: 20261014, verbose: true },
    );
  });
});

describe('canSee', () => {
  const principal = (grant: Grant) => ({ userId: USER, grant });

  it('shows the website to every admitted principal and nothing to an anonymous one', () => {
    for (const grant of ['owner', 'organizer_role', 'allowlist'] as const) {
      expect(canSee(principal(grant), { kind: 'website' })).toBe(true);
    }
    expect(canSee(null, { kind: 'website' })).toBe(false);
    expect(canSee(null, { kind: 'settings' })).toBe(false);
    expect(canSee(null, { kind: 'organizer_allowlist' })).toBe(false);
  });

  it('shows settings to organizers and the allowlist to the owner only', () => {
    for (const grant of ['owner', 'organizer_role', 'allowlist'] as const) {
      expect(canSee(principal(grant), { kind: 'settings' })).toBe(true);
    }
    expect(canSee(principal('owner'), { kind: 'organizer_allowlist' })).toBe(true);
    expect(canSee(principal('organizer_role'), { kind: 'organizer_allowlist' })).toBe(false);
    expect(canSee(principal('allowlist'), { kind: 'organizer_allowlist' })).toBe(false);
  });
});
