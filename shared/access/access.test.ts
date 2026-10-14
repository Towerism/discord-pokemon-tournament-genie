import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLUEPRINT, type PlanInput, desiredChannels } from '../blueprints';
import { type AccessPlan, type Grant, type Principal, type Resource, accessPlan, canSee, decideAccess } from './access';

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
  dayHeadJudge: false,
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
          const result = decideAccess({ userId, member, ownerId, organizerRoleId, allowlist: { enabled, userIds }, dayHeadJudge: false });
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

describe('decideAccess for day head judges', () => {
  it('admits a day head judge without an organizer grant, after the organizer grants', () => {
    expect(decideAccess(input({ dayHeadJudge: true }))).toEqual({ allowed: true, grant: 'event_head_judge' });
    expect(decideAccess(input({ dayHeadJudge: true, member: { userId: USER, roleIds: [ORGANIZER_ROLE] } }))).toEqual({
      allowed: true,
      grant: 'organizer_role',
    });
    expect(decideAccess(input({ dayHeadJudge: true, member: null }))).toEqual({ allowed: false, reason: 'not_in_guild' });
  });

  it('admits an organizer-role holder left off the allowlist only as a head judge', () => {
    const member = { userId: USER, roleIds: [ORGANIZER_ROLE] };
    expect(decideAccess(input({ member, dayHeadJudge: true, allowlist: { enabled: true, userIds: [] } }))).toEqual({
      allowed: true,
      grant: 'event_head_judge',
    });
  });
});

describe('canSee for days and channels (ADR-0010)', () => {
  const LC = 11;
  const VGC = 12;
  const HJ = '100000000000000011';
  const ROLE_HJ = '100000000000000012';
  const JUDGE = '100000000000000013';
  const plan: AccessPlan = {
    dayId: 1,
    staff: [
      { discordUserId: HJ, headJudgeOf: [LC] },
      { discordUserId: ROLE_HJ, headJudgeOf: [] },
      { discordUserId: JUDGE, headJudgeOf: [] },
    ],
    channels: [
      { key: 'day-staff', eventId: null, audienceUserIds: [HJ, ROLE_HJ, JUDGE] },
      { key: 'head-judges', eventId: null, audienceUserIds: [HJ, ROLE_HJ] },
      { key: 'penalties', eventId: LC, audienceUserIds: [HJ, JUDGE] },
      { key: 'penalties', eventId: VGC, audienceUserIds: [HJ] },
    ],
  };
  const hj = (userId: string, holdsHeadJudgeRole = false): Principal => ({ userId, grant: 'event_head_judge', holdsHeadJudgeRole });
  const channel = (blueprintKey: string, eventId: number | null): Resource => ({ kind: 'channel', blueprintKey, eventId });
  const day = (action: 'read' | 'preview' | 'sync' | 'edit' | 'open'): Resource => ({ kind: 'day', action });
  const install: Resource[] = [{ kind: 'settings' }, { kind: 'directory' }, { kind: 'configuration' }, { kind: 'members' }, { kind: 'days' }, { kind: 'day_create' }];

  it('builds the access plan from the same desired channels provisioning applies', () => {
    const plan: PlanInput = {
      day: { id: 7, date: '2026-10-17', title: 'T' },
      events: [
        { id: LC, name: 'LC', slug: 'lc', startsAt: 1, gameConfirmed: true },
        { id: VGC, name: 'VGC', slug: 'vgc', startsAt: 2, gameConfirmed: true },
      ],
      staff: [
        { staffMemberId: 1, discordUserId: HJ, linkState: 'linked', events: [{ eventId: LC, role: 'headjudge' }, { eventId: VGC, role: 'judge' }] },
        { staffMemberId: 2, discordUserId: null, linkState: 'claimed', events: [{ eventId: LC, role: 'headjudge' }] },
      ],
    };
    const desired = desiredChannels(plan, DEFAULT_BLUEPRINT, { guildId: '4', botUserId: '3', organizerRoleId: '2', headJudgeRoleHolders: new Set(), guildMemberIds: null });
    const access = accessPlan(plan, desired);
    expect(access.dayId).toBe(7);
    expect(access.staff).toEqual([{ discordUserId: HJ, headJudgeOf: [LC] }]);
    expect(canSee(hj(HJ), channel('penalties', LC), access)).toBe(true);
    expect(canSee(hj(HJ), channel('penalties', VGC), access)).toBe(false);
    expect(canSee(hj(HJ), day('read'), access)).toBe(true);
  });

  it('lets organizers see every day resource, with or without the plan', () => {
    for (const grant of ['owner', 'organizer_role', 'allowlist'] as const) {
      const p: Principal = { userId: USER, grant, holdsHeadJudgeRole: false };
      for (const r of [...install, day('edit'), day('open'), channel('penalties', VGC)]) expect(canSee(p, r, plan)).toBe(true);
      expect(canSee(p, day('read'))).toBe(true);
    }
  });

  it('scopes an event head judge to their day and their event', () => {
    const p = hj(HJ);
    for (const a of ['read', 'preview', 'sync'] as const) expect(canSee(p, day(a), plan)).toBe(true);
    expect(canSee(p, day('edit'), plan)).toBe(false);
    expect(canSee(p, day('open'), plan)).toBe(false);
    expect(canSee(p, channel('penalties', LC), plan)).toBe(true);
    expect(canSee(p, channel('penalties', VGC), plan)).toBe(false);
    expect(canSee(p, channel('head-judges', null), plan)).toBe(true);
    expect(canSee(p, { kind: 'website' }, plan)).toBe(true);
    for (const r of install) expect(canSee(p, r, plan)).toBe(false);
  });

  it('gives the head-judge role #head-judges and Sync, never an event’s channel', () => {
    const p = hj(ROLE_HJ, true);
    expect(canSee(p, day('sync'), plan)).toBe(true);
    expect(canSee(p, channel('head-judges', null), plan)).toBe(true);
    expect(canSee(p, channel('penalties', LC), plan)).toBe(false);
    expect(canSee(hj(ROLE_HJ, false), day('read'), plan)).toBe(false);
  });

  it('refuses another day’s plan, a judge, and any day resource without the plan', () => {
    expect(canSee(hj(USER, true), day('read'), plan)).toBe(false);
    expect(canSee(hj(JUDGE), day('read'), plan)).toBe(false);
    expect(canSee(hj(JUDGE), channel('penalties', LC), plan)).toBe(false);
    expect(canSee(hj(HJ), day('read'))).toBe(false);
    expect(canSee(hj(HJ), channel('penalties', LC))).toBe(false);
    expect(canSee(null, day('read'), plan)).toBe(false);
  });

  it('never shows a channel to someone outside its Discord audience, and the role never reaches an event', () => {
    const ids = ['100000000000000021', '100000000000000022', '100000000000000023', '100000000000000024'];
    const plans = fc.record({
      staff: fc.uniqueArray(fc.record({ discordUserId: fc.constantFrom(...ids), headJudgeOf: fc.uniqueArray(fc.constantFrom(1, 2)) }), {
        selector: (s) => s.discordUserId,
      }),
      channels: fc.array(fc.record({ key: fc.constantFrom('a', 'b'), eventId: fc.constantFrom(null, 1, 2), audienceUserIds: fc.uniqueArray(fc.constantFrom(...ids)) })),
    });
    const principals = fc.record({
      userId: fc.constantFrom(...ids),
      grant: fc.constantFrom<Grant>('owner', 'organizer_role', 'allowlist', 'event_head_judge'),
      holdsHeadJudgeRole: fc.boolean(),
    });
    fc.assert(
      fc.property(principals, plans, fc.constantFrom('a', 'b'), fc.constantFrom(null, 1, 2), (p, rawPlan, key, eventId) => {
        const access: AccessPlan = { dayId: 1, ...rawPlan };
        if (!canSee(p, { kind: 'channel', blueprintKey: key, eventId }, access)) return;
        if (p.grant !== 'event_head_judge') return;
        const ch = access.channels.find((c) => c.key === key && c.eventId === eventId);
        expect(ch?.audienceUserIds).toContain(p.userId);
        if (eventId !== null) expect(access.staff.find((s) => s.discordUserId === p.userId)?.headJudgeOf).toContain(eventId);
      }),
      { seed: 20261014, numRuns: 1000 },
    );
  });
});

describe('canSee', () => {
  const principal = (grant: Grant): Principal => ({ userId: USER, grant, holdsHeadJudgeRole: false });

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
