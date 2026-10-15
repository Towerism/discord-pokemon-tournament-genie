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
      { discordUserId: HJ, headJudgeOf: [LC], staffOf: [LC] },
      { discordUserId: ROLE_HJ, headJudgeOf: [], staffOf: [] },
      { discordUserId: JUDGE, headJudgeOf: [], staffOf: [LC] },
    ],
    channels: [
      { key: 'day-staff', eventId: null, purpose: 'general', audienceUserIds: [HJ, ROLE_HJ, JUDGE] },
      { key: 'head-judges', eventId: null, purpose: 'general', audienceUserIds: [HJ, ROLE_HJ] },
      { key: 'penalties', eventId: LC, purpose: 'penalties', audienceUserIds: [HJ, JUDGE] },
      { key: 'penalties', eventId: VGC, purpose: 'penalties', audienceUserIds: [HJ] },
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
    expect(access.staff).toEqual([{ discordUserId: HJ, headJudgeOf: [LC], staffOf: [LC, VGC] }]);
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
      staff: fc.uniqueArray(fc.record({ discordUserId: fc.constantFrom(...ids), headJudgeOf: fc.uniqueArray(fc.constantFrom(1, 2)), staffOf: fc.uniqueArray(fc.constantFrom(1, 2)) }), {
        selector: (s) => s.discordUserId,
      }),
      channels: fc.array(fc.record({ key: fc.constantFrom('a', 'b'), eventId: fc.constantFrom(null, 1, 2), purpose: fc.constantFrom<'general' | 'penalties'>('general', 'penalties'), audienceUserIds: fc.uniqueArray(fc.constantFrom(...ids)) })),
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

describe('canSee for close-out (ADR-0010)', () => {
  const LC = 11;
  const VGC = 12;
  const HJ = '100000000000000011';
  const ROLE_HJ = '100000000000000012';
  const JUDGE = '100000000000000013';
  const VGC_HJ = '100000000000000014';
  const plan: AccessPlan = {
    dayId: 1,
    staff: [
      { discordUserId: HJ, headJudgeOf: [LC], staffOf: [LC] },
      { discordUserId: ROLE_HJ, headJudgeOf: [], staffOf: [] },
      { discordUserId: JUDGE, headJudgeOf: [], staffOf: [LC] },
      { discordUserId: VGC_HJ, headJudgeOf: [VGC], staffOf: [VGC] },
    ],
    channels: [
      { key: 'day-staff', eventId: null, purpose: 'general', audienceUserIds: [HJ, ROLE_HJ, JUDGE, VGC_HJ] },
      { key: 'head-judges', eventId: null, purpose: 'general', audienceUserIds: [HJ, ROLE_HJ, VGC_HJ] },
      { key: 'floor', eventId: LC, purpose: 'floor', audienceUserIds: [HJ, JUDGE] },
      { key: 'floor', eventId: VGC, purpose: 'floor', audienceUserIds: [VGC_HJ] },
    ],
  };
  const hj = (userId: string, holdsHeadJudgeRole = false): Principal => ({ userId, grant: 'event_head_judge', holdsHeadJudgeRole });
  const organizer: Principal = { userId: USER, grant: 'organizer_role', holdsHeadJudgeRole: false };
  const csv = (eventId: number, dayPurged = false): Resource => ({ kind: 'export_file', file: { kind: 'csv', eventId }, dayPurged });
  const transcript = (blueprintKey: string, eventId: number | null, opts: { privateThread?: boolean; dayPurged?: boolean } = {}): Resource => ({
    kind: 'export_file',
    file: { kind: 'transcript', blueprintKey, eventId, privateThread: opts.privateThread ?? false },
    dayPurged: opts.dayPurged ?? false,
  });

  it('lets day head judges close, and only organizers act on the close-out', () => {
    expect(canSee(hj(HJ), { kind: 'day', action: 'close' }, plan)).toBe(true);
    expect(canSee(hj(ROLE_HJ, true), { kind: 'day', action: 'close' }, plan)).toBe(true);
    expect(canSee(hj(JUDGE), { kind: 'day', action: 'close' }, plan)).toBe(false);
    expect(canSee(hj(HJ), { kind: 'day', action: 'closeout' }, plan)).toBe(false);
    expect(canSee(organizer, { kind: 'day', action: 'closeout' })).toBe(true);
  });

  it('gives an event’s CSVs to its head judges, and transcripts as Discord showed the channel', () => {
    expect(canSee(hj(HJ), csv(LC), plan)).toBe(true);
    expect(canSee(hj(HJ), csv(VGC), plan)).toBe(false);
    expect(canSee(hj(JUDGE), csv(LC), plan)).toBe(false);
    expect(canSee(hj(HJ), transcript('floor', LC), plan)).toBe(true);
    expect(canSee(hj(HJ), transcript('floor', VGC), plan)).toBe(false);
    expect(canSee(hj(VGC_HJ), transcript('head-judges', null), plan)).toBe(true);
    expect(canSee(hj(ROLE_HJ, true), transcript('head-judges', null), plan)).toBe(true);
    expect(canSee(hj(ROLE_HJ, true), transcript('floor', LC), plan)).toBe(false);
    expect(canSee(hj(HJ), transcript('retired', LC), plan)).toBe(false);
  });

  it('keeps private threads and a purged day’s files to organizers', () => {
    expect(canSee(hj(HJ), transcript('floor', LC, { privateThread: true }), plan)).toBe(false);
    expect(canSee(hj(HJ), csv(LC, true), plan)).toBe(false);
    expect(canSee(hj(HJ), transcript('floor', LC, { dayPurged: true }), plan)).toBe(false);
    for (const r of [transcript('floor', LC, { privateThread: true }), csv(LC, true), transcript('retired', VGC, { dayPurged: true })]) expect(canSee(organizer, r)).toBe(true);
  });

  it('never gives a non-organizer a file of a channel outside their Discord audience (property)', () => {
    const ids = ['100000000000000021', '100000000000000022', '100000000000000023'];
    const plans = fc.record({
      staff: fc.uniqueArray(fc.record({ discordUserId: fc.constantFrom(...ids), headJudgeOf: fc.uniqueArray(fc.constantFrom(1, 2)), staffOf: fc.uniqueArray(fc.constantFrom(1, 2)) }), {
        selector: (s) => s.discordUserId,
      }),
      channels: fc.array(fc.record({ key: fc.constantFrom('a', 'b'), eventId: fc.constantFrom(null, 1, 2), purpose: fc.constantFrom<'general' | 'penalties'>('general', 'penalties'), audienceUserIds: fc.uniqueArray(fc.constantFrom(...ids)) })),
    });
    const files = fc.oneof(
      fc.record({ kind: fc.constant('csv' as const), eventId: fc.constantFrom(1, 2) }),
      fc.record({ kind: fc.constant('transcript' as const), blueprintKey: fc.constantFrom('a', 'b'), eventId: fc.constantFrom(null, 1, 2), privateThread: fc.boolean() }),
    );
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.boolean(), plans, files, fc.boolean(), (userId, holdsHeadJudgeRole, rawPlan, file, dayPurged) => {
        const access: AccessPlan = { dayId: 1, ...rawPlan };
        const p: Principal = { userId, grant: 'event_head_judge', holdsHeadJudgeRole };
        if (!canSee(p, { kind: 'export_file', file, dayPurged }, access)) return;
        expect(dayPurged).toBe(false);
        const staffer = access.staff.find((s) => s.discordUserId === userId);
        if (file.kind === 'csv') {
          expect(staffer?.headJudgeOf).toContain(file.eventId);
        } else {
          expect(file.privateThread).toBe(false);
          expect(access.channels.find((c) => c.key === file.blueprintKey && c.eventId === file.eventId)?.audienceUserIds).toContain(userId);
        }
      }),
      { seed: 20261015, numRuns: 1000 },
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

describe('canSee for event penalties (ADR-0010)', () => {
  const TCG = 21;
  const VGC = 22;
  const HJ = '100000000000000031';
  const JUDGE = '100000000000000032';
  const SCORER = '100000000000000033';
  const ROLE_HJ = '100000000000000034';
  const plan: AccessPlan = {
    dayId: 1,
    staff: [
      { discordUserId: HJ, headJudgeOf: [TCG], staffOf: [TCG] },
      { discordUserId: JUDGE, headJudgeOf: [], staffOf: [TCG, VGC] },
      { discordUserId: SCORER, headJudgeOf: [], staffOf: [VGC] },
      { discordUserId: ROLE_HJ, headJudgeOf: [], staffOf: [] },
    ],
    channels: [
      { key: 'day-staff', eventId: null, purpose: 'general', audienceUserIds: [HJ, JUDGE, SCORER, ROLE_HJ] },
      { key: 'penalties', eventId: TCG, purpose: 'penalties', audienceUserIds: [HJ, JUDGE] },
      // VGC's penalties channel is head judges only: its scorekeeper may record, never list.
      { key: 'penalties', eventId: VGC, purpose: 'penalties', audienceUserIds: [] },
    ],
  };
  const p = (userId: string, holdsHeadJudgeRole = false): Principal => ({ userId, grant: 'event_head_judge', holdsHeadJudgeRole });
  const pen = (eventId: number, action: 'record' | 'list' | 'manage'): Resource => ({ kind: 'event_penalties', eventId, action });

  it('lets organizers record, list and manage every event', () => {
    for (const grant of ['owner', 'organizer_role', 'allowlist'] as const) {
      for (const action of ['record', 'list', 'manage'] as const) expect(canSee({ userId: USER, grant, holdsHeadJudgeRole: false }, pen(VGC, action), plan)).toBe(true);
    }
  });

  it('lets an event head judge manage only their event', () => {
    expect(canSee(p(HJ), pen(TCG, 'manage'), plan)).toBe(true);
    expect(canSee(p(HJ), pen(VGC, 'manage'), plan)).toBe(false);
    expect(canSee(p(HJ), pen(VGC, 'record'), plan)).toBe(false);
  });

  it('lets any staffer of the event record, and list only from inside the penalties channel audience', () => {
    expect(canSee(p(JUDGE), pen(TCG, 'record'), plan)).toBe(true);
    expect(canSee(p(JUDGE), pen(TCG, 'list'), plan)).toBe(true);
    expect(canSee(p(JUDGE), pen(TCG, 'manage'), plan)).toBe(false);
    expect(canSee(p(SCORER), pen(VGC, 'record'), plan)).toBe(true);
    expect(canSee(p(SCORER), pen(VGC, 'list'), plan)).toBe(false);
    expect(canSee(p(SCORER), pen(TCG, 'record'), plan)).toBe(false);
  });

  it('lets a staffer list when the event has no penalties channel', () => {
    const noChannel: AccessPlan = { ...plan, channels: plan.channels.filter((c) => c.eventId !== VGC) };
    expect(canSee(p(SCORER), pen(VGC, 'list'), noChannel)).toBe(true);
  });

  it('gives the head-judge role nothing on an event, and nothing without the plan', () => {
    for (const action of ['record', 'list', 'manage'] as const) {
      expect(canSee(p(ROLE_HJ, true), pen(TCG, action), plan)).toBe(false);
      expect(canSee(p(HJ), pen(TCG, action))).toBe(false);
      expect(canSee(null, pen(TCG, action), plan)).toBe(false);
    }
  });

  it('builds staffOf and the channel purposes from the plan provisioning applies', () => {
    const input: PlanInput = {
      day: { id: 7, date: '2026-10-17', title: 'T' },
      events: [{ id: TCG, name: 'TCG', slug: 'tcg', startsAt: 1, gameConfirmed: true }],
      staff: [{ staffMemberId: 1, discordUserId: JUDGE, linkState: 'linked', events: [{ eventId: TCG, role: 'scorekeeper' }] }],
    };
    const desired = desiredChannels(input, DEFAULT_BLUEPRINT, { guildId: '4', botUserId: '3', organizerRoleId: '2', headJudgeRoleHolders: new Set(), guildMemberIds: null });
    const access = accessPlan(input, desired);
    expect(access.staff).toEqual([{ discordUserId: JUDGE, headJudgeOf: [], staffOf: [TCG] }]);
    expect(access.channels.find((c) => c.key === 'penalties')).toMatchObject({ eventId: TCG, purpose: 'penalties' });
    expect(access.channels.find((c) => c.key === 'floor')).toMatchObject({ purpose: 'floor' });
  });

  it('never lets a non-organizer manage outside their event or record off its staff (property)', () => {
    const ids = ['100000000000000041', '100000000000000042', '100000000000000043'];
    const events = [1, 2];
    const plans = fc.record({
      staff: fc.uniqueArray(
        fc.record({ discordUserId: fc.constantFrom(...ids), headJudgeOf: fc.uniqueArray(fc.constantFrom(...events)), staffOf: fc.uniqueArray(fc.constantFrom(...events)) }),
        { selector: (s) => s.discordUserId },
      ),
      channels: fc.array(
        fc.record({
          key: fc.constantFrom('penalties', 'floor'),
          eventId: fc.constantFrom(null, ...events),
          purpose: fc.constantFrom<'general' | 'floor' | 'penalties'>('general', 'floor', 'penalties'),
          audienceUserIds: fc.uniqueArray(fc.constantFrom(...ids)),
        }),
      ),
    });
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.boolean(), plans, fc.constantFrom(...events), fc.constantFrom<'record' | 'list' | 'manage'>('record', 'list', 'manage'), (userId, role, raw, eventId, action) => {
        // A head judge is always on the event's staff: accessPlan guarantees it, so the generator does too.
        const staff = raw.staff.map((s) => ({ ...s, staffOf: [...new Set([...s.staffOf, ...s.headJudgeOf])] }));
        const access: AccessPlan = { dayId: 1, staff, channels: raw.channels };
        if (!canSee({ userId, grant: 'event_head_judge', holdsHeadJudgeRole: role }, { kind: 'event_penalties', eventId, action }, access)) return;
        const me = staff.find((s) => s.discordUserId === userId);
        expect(me?.staffOf).toContain(eventId);
        if (action === 'manage') expect(me?.headJudgeOf).toContain(eventId);
        if (action === 'list') {
          for (const c of access.channels.filter((c) => c.eventId === eventId && c.purpose === 'penalties')) expect(c.audienceUserIds).toContain(userId);
        }
      }),
      { seed: 20261014, numRuns: 1000 },
    );
  });
});
