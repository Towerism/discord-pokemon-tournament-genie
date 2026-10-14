import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonical, targetKey } from '../discord/overwrites';
import { PERMISSION_BITS as P } from '../discord/permissions';
import {
  type BlueprintChannelInput,
  type BlueprintInput,
  DEFAULT_BLUEPRINT,
  type DesiredContext,
  type PlanInput,
  dateTokens,
  deriveSlug,
  desiredChannels,
  formatName,
  revokesAccess,
  validateBlueprint,
} from './index';

const GUILD = '400000000000000001';
const BOT = '300000000000000009';
const ORG_ROLE = '200000000000000001';
const HJ_ROLE_HOLDER = '100000000000000099';
const SEED = 20261014;

const ctx = (over: Partial<DesiredContext> = {}): DesiredContext => ({
  guildId: GUILD,
  botUserId: BOT,
  organizerRoleId: ORG_ROLE,
  headJudgeRoleHolders: new Set<string>(),
  guildMemberIds: null,
  ...over,
});

const LC = 11;
const VGC = 12;
const user = (n: number) => `10000000000000000${n}`;

/** The AC-14 day: LC (A headjudge, B judge), VGC (C judge), D day staff only with the head-judge role, E claimed, F linked but gone. */
function octoberDay(): PlanInput {
  return {
    day: { id: 1, date: '2026-10-17', title: 'October LC' },
    events: [
      { id: VGC, name: 'VGC', slug: 'vgc', startsAt: Date.UTC(2026, 9, 17, 16, 30), gameConfirmed: true },
      { id: LC, name: 'LC', slug: 'lc', startsAt: Date.UTC(2026, 9, 17, 15, 0), gameConfirmed: true },
    ],
    staff: [
      { staffMemberId: 1, discordUserId: user(1), linkState: 'linked', events: [{ eventId: LC, role: 'headjudge' }] },
      { staffMemberId: 2, discordUserId: user(2), linkState: 'linked', events: [{ eventId: LC, role: 'judge' }] },
      { staffMemberId: 3, discordUserId: user(3), linkState: 'linked', events: [{ eventId: VGC, role: 'judge' }] },
      { staffMemberId: 4, discordUserId: user(4), linkState: 'linked', events: [] },
      { staffMemberId: 5, discordUserId: null, linkState: 'claimed', events: [{ eventId: LC, role: 'judge' }] },
      { staffMemberId: 6, discordUserId: user(6), linkState: 'linked', events: [{ eventId: VGC, role: 'judge' }] },
    ],
  };
}

const audience = (day: ReturnType<typeof desiredChannels>, key: string, eventId: number | null) =>
  day.channels
    .find((c) => c.key === key && c.eventId === eventId)!
    .audience.map((a) => a.staffMemberId)
    .sort();

describe('validateBlueprint', () => {
  const channel = (over: Partial<BlueprintChannelInput>): BlueprintChannelInput => ({
    key: 'x',
    scope: 'day',
    kind: 'text',
    namePattern: 'x',
    audience: 'all_staff',
    purpose: 'general',
    topic: null,
    position: 0,
    ...over,
  });
  const bp = (channels: BlueprintChannelInput[], categoryNamePattern = '{title}'): BlueprintInput => ({ name: 'B', categoryNamePattern, channels });
  const codes = (b: BlueprintInput) => validateBlueprint(b).map((p) => p.code);

  it('accepts the default blueprint', () => {
    expect(validateBlueprint(DEFAULT_BLUEPRINT)).toEqual([]);
  });

  it('never lets a per-event channel widen to all staff', () => {
    expect(codes(bp([channel({ scope: 'per_event', namePattern: '{slug}-x', audience: 'all_staff' })]))).toEqual(['audience_not_allowed']);
  });

  it('refuses event_staff on a day channel', () => {
    expect(codes(bp([channel({ audience: 'event_staff' })]))).toEqual(['audience_not_allowed']);
  });

  it('needs {slug} in a per-event pattern and refuses event tokens in a day pattern', () => {
    expect(codes(bp([channel({ scope: 'per_event', namePattern: '{event}-x', audience: 'event_staff' })]))).toEqual(['slug_required']);
    expect(codes(bp([channel({ namePattern: '{event}-talk' })]))).toEqual(['event_token_in_day_channel']);
    expect(codes(bp([channel({ namePattern: '{slug}-talk' })]))).toEqual(['event_token_in_day_channel']);
  });

  it('refuses unknown tokens, in channels, topics and the category', () => {
    expect(codes(bp([channel({ namePattern: '{foo}' })]))).toEqual(['unknown_token']);
    expect(codes(bp([channel({ topic: 'about {foo}' })]))).toEqual(['unknown_token']);
    expect(codes(bp([channel({})], '{bar} day'))).toEqual(['unknown_token']);
    expect(codes(bp([channel({})], '{slug} day'))).toEqual(['unknown_token']);
  });

  it('refuses voice channels, duplicate keys, bad keys and too many channels', () => {
    expect(codes(bp([channel({ kind: 'voice' })]))).toEqual(['voice_not_supported']);
    expect(codes(bp([channel({ key: 'floor' }), channel({ key: 'floor', namePattern: 'y' })]))).toEqual(['duplicate_key']);
    expect(codes(bp([channel({ key: 'Floor!' })]))).toEqual(['invalid_key']);
    const eleven = Array.from({ length: 11 }, (_, i) => channel({ key: `d${i}`, namePattern: `d${i}` }));
    expect(codes(bp(eleven))).toEqual(['too_many_day_channels']);
    const nine = Array.from({ length: 9 }, (_, i) => channel({ key: `e${i}`, scope: 'per_event', audience: 'event_staff', namePattern: `{slug}-e${i}` }));
    expect(codes(bp(nine))).toEqual(['too_many_event_channels']);
  });

  it('names where each problem is', () => {
    expect(validateBlueprint(bp([channel({}), channel({ key: 'y', kind: 'voice' })]))).toEqual([{ path: 'channels.1.kind', code: 'voice_not_supported' }]);
  });
});

describe('desiredChannels', () => {
  it('builds the AC-14 day with the right names, order and audiences', () => {
    const day = desiredChannels(octoberDay(), DEFAULT_BLUEPRINT, ctx({ headJudgeRoleHolders: new Set([user(4)]), guildMemberIds: new Set([1, 2, 3, 4, 5].map(user)) }));
    expect(day.category.name).toBe('🏆 Sat Oct 17 · October LC');
    expect(day.channels.map((c) => c.name)).toEqual(['day-staff', 'head-judges', 'lc-floor', 'lc-penalties', 'vgc-floor', 'vgc-penalties']);
    expect(audience(day, 'day-staff', null)).toEqual([1, 2, 3, 4]);
    expect(audience(day, 'head-judges', null)).toEqual([1, 4]);
    expect(audience(day, 'floor', LC)).toEqual([1, 2]);
    expect(audience(day, 'penalties', LC)).toEqual([1, 2]);
    expect(audience(day, 'floor', VGC)).toEqual([3]);
    expect(audience(day, 'penalties', VGC)).toEqual([3]);
  });

  it('writes exactly the four kinds of overwrites, never Manage Roles', () => {
    const day = desiredChannels(octoberDay(), DEFAULT_BLUEPRINT, ctx());
    const STAFF = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AttachFiles;
    const base = [
      `everyone|0|${P.ViewChannel}`,
      `member:${BOT}|${P.ViewChannel | P.SendMessages | P.ManageChannels}|0`,
      `role:${ORG_ROLE}|${P.ViewChannel}|0`,
    ];
    expect(canonical(day.category.overwrites)).toEqual([...base].sort());
    const lcFloor = day.channels.find((c) => c.name === 'lc-floor')!;
    expect(canonical(lcFloor.overwrites)).toEqual([...base, `member:${user(1)}|${STAFF}|0`, `member:${user(2)}|${STAFF}|0`].sort());
    for (const c of [day.category, ...day.channels]) {
      for (const o of c.overwrites) expect(o.allow & P.ManageRoles, targetKey(o.target)).toBe(0n);
    }
  });

  it('reports unlinked staff and unconfirmed games', () => {
    const plan = octoberDay();
    plan.events[0]!.gameConfirmed = false;
    const day = desiredChannels(plan, DEFAULT_BLUEPRINT, ctx());
    expect(day.problems).toContainEqual({ code: 'unlinked_staff', staffMemberIds: [5] });
    expect(day.problems).toContainEqual({ code: 'unconfirmed_game', eventIds: [VGC] });
  });

  it('reports two channels resolving to the same name', () => {
    const blueprint: BlueprintInput = {
      ...DEFAULT_BLUEPRINT,
      channels: [...DEFAULT_BLUEPRINT.channels, { key: 'lc-floor', scope: 'day', kind: 'text', namePattern: 'lc-floor', audience: 'all_staff', purpose: 'general', topic: null, position: 9 }],
    };
    expect(desiredChannels(octoberDay(), blueprint, ctx()).problems).toContainEqual({ code: 'duplicate_channel_name', name: 'lc-floor', keys: ['floor', 'lc-floor'] });
  });

  it('narrows a per-event head_judges channel to that event’s head judges, never a role holder', () => {
    const blueprint: BlueprintInput = {
      ...DEFAULT_BLUEPRINT,
      channels: [{ key: 'hj', scope: 'per_event', kind: 'text', namePattern: '{slug}-hj', audience: 'head_judges', purpose: 'general', topic: null, position: 0 }],
    };
    const day = desiredChannels(octoberDay(), blueprint, ctx({ headJudgeRoleHolders: new Set([user(4), user(2)]) }));
    expect(audience(day, 'hj', LC)).toEqual([1]);
    expect(audience(day, 'hj', VGC)).toEqual([]);
  });

  it('orders channels by position then key, and events by start then name', () => {
    const plan = octoberDay();
    plan.events = [
      { id: 2, name: 'B', slug: 'b', startsAt: 5, gameConfirmed: true },
      { id: 1, name: 'A', slug: 'a', startsAt: 5, gameConfirmed: true },
    ];
    const blueprint: BlueprintInput = {
      ...DEFAULT_BLUEPRINT,
      channels: [
        { key: 'zz', scope: 'per_event', kind: 'text', namePattern: '{slug}-zz', audience: 'event_staff', purpose: 'floor', topic: null, position: 1 },
        { key: 'aa', scope: 'per_event', kind: 'text', namePattern: '{slug}-aa', audience: 'event_staff', purpose: 'floor', topic: null, position: 1 },
      ],
    };
    expect(desiredChannels(plan, blueprint, ctx()).channels.map((c) => c.name)).toEqual(['a-aa', 'a-zz', 'b-aa', 'b-zz']);
  });

  it('fills an unknown token with nothing rather than leaking the pattern', () => {
    expect(formatName('{nope}-x', { slug: '', event: '', title: '', date: '', weekday: '' }, 'text')).toBe('x');
  });

  it('fills topics with the same tokens', () => {
    const blueprint: BlueprintInput = { ...DEFAULT_BLUEPRINT, channels: DEFAULT_BLUEPRINT.channels.map((c) => ({ ...c, topic: c.scope === 'per_event' ? '{event} on {date}' : null })) };
    expect(desiredChannels(octoberDay(), blueprint, ctx()).channels.find((c) => c.name === 'lc-floor')!.topic).toBe('LC on Oct 17');
  });

  it('only ever gives access to linked staff of the day, and is deterministic', () => {
    const roles = fc.constantFrom('headjudge', 'judge', 'scorekeeper', 'administration', 'translator');
    const plans = fc
      .record({
        eventCount: fc.integer({ min: 0, max: 4 }),
        staff: fc.array(
          fc.record({ linkState: fc.constantFrom('linked', 'claimed', 'unlinked'), roleHolder: fc.boolean(), inGuild: fc.boolean(), roles: fc.array(fc.option(roles), { maxLength: 4 }) }),
          { maxLength: 8 },
        ),
        memberList: fc.boolean(),
      })
      .map(({ eventCount, staff, memberList }) => {
        const events = Array.from({ length: eventCount }, (_, i) => ({ id: 100 + i, name: `E${i}`, slug: `e${i}`, startsAt: i, gameConfirmed: true }));
        const people = staff.map((s, i) => ({
          staffMemberId: i + 1,
          discordUserId: s.linkState === 'linked' ? user(i + 1) : null,
          linkState: s.linkState as 'linked' | 'claimed' | 'unlinked',
          events: s.roles.slice(0, eventCount).flatMap((r, e) => (r ? [{ eventId: 100 + e, role: r }] : [])),
        }));
        const plan: PlanInput = { day: { id: 1, date: '2026-10-18', title: 'T' }, events, staff: people };
        const c = ctx({
          headJudgeRoleHolders: new Set([...staff.flatMap((s, i) => (s.roleHolder ? [user(i + 1)] : [])), HJ_ROLE_HOLDER]),
          guildMemberIds: memberList ? new Set(staff.flatMap((s, i) => (s.inGuild ? [user(i + 1)] : []))) : null,
        });
        return { plan, c };
      });
    fc.assert(
      fc.property(plans, ({ plan, c }) => {
        const day = desiredChannels(plan, DEFAULT_BLUEPRINT, c);
        const linked = new Set(plan.staff.filter((s) => s.linkState === 'linked').map((s) => s.discordUserId));
        for (const ch of day.channels) {
          for (const a of ch.audience) {
            expect(linked.has(a.discordUserId)).toBe(true);
            if (c.guildMemberIds) expect(c.guildMemberIds.has(a.discordUserId)).toBe(true);
            expect(a.discordUserId).not.toBe(HJ_ROLE_HOLDER);
            if (ch.eventId !== null) {
              const s = plan.staff.find((p) => p.staffMemberId === a.staffMemberId)!;
              expect(s.events.some((e) => e.eventId === ch.eventId)).toBe(true);
            }
          }
        }
        expect(desiredChannels(plan, DEFAULT_BLUEPRINT, c)).toEqual(day);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe('dateTokens', () => {
  it('reads the calendar date with no time-zone conversion', () => {
    expect(process.env.TZ).toBe('America/Chicago');
    expect(dateTokens('2026-10-17')).toEqual({ weekday: 'Sat', date: 'Oct 17' });
    expect(dateTokens('2026-11-01')).toEqual({ weekday: 'Sun', date: 'Nov 1' });
    fc.assert(
      fc.property(fc.date({ min: new Date(Date.UTC(2020, 0, 1)), max: new Date(Date.UTC(2035, 11, 31)), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        // The process runs in America/Chicago, where UTC midnight is the day before: a time-zone bug shows here.
        const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
        expect(dateTokens(iso).weekday, iso).toBe(weekday);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

describe('formatName', () => {
  it('normalizes text channel names the way Discord does', () => {
    const vars = { slug: 'go-fest', event: 'Pokémon GO Fest!', title: 'T', date: 'Oct 18', weekday: 'Sat' };
    expect(formatName('{event} talk', vars, 'text')).toBe('pokémon-go-fest-talk');
    expect(formatName('  A -- B  ', vars, 'text')).toBe('a-b');
    expect(formatName('x'.repeat(120), vars, 'text')).toHaveLength(100);
  });

  it('keeps a category name as written, trimmed to 100', () => {
    expect(formatName('🏆 {weekday} {date} · {title}', { slug: '', event: '', title: 'October LC', date: 'Oct 18', weekday: 'Sat' }, 'category')).toBe('🏆 Sat Oct 18 · October LC');
  });
});

describe('deriveSlug', () => {
  it('derives a unique, valid slug from the name', () => {
    expect(deriveSlug('LC', [])).toBe('lc');
    expect(deriveSlug('LC!', ['lc'])).toBe('lc-2');
    expect(deriveSlug('LC', ['lc', 'lc-2'])).toBe('lc-3');
    expect(deriveSlug('  --Pokémon GO--  ', [])).toBe('pok-mon-go');
    expect(deriveSlug('🎉🎉', [])).toBe('event');
  });

  it('never exceeds 32 characters or ends in a dash', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.array(fc.string({ maxLength: 34 }), { maxLength: 5 }), (name, taken) => {
        const slug = deriveSlug(name, taken);
        expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);
        expect(taken).not.toContain(slug);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe('revokesAccess', () => {
  const day = (plan: PlanInput) => desiredChannels(plan, DEFAULT_BLUEPRINT, ctx());

  it('is false for an addition and true for a removal or a narrowing role change', () => {
    const before = octoberDay();
    const added = octoberDay();
    added.staff.push({ staffMemberId: 7, discordUserId: user(7), linkState: 'linked', events: [{ eventId: VGC, role: 'judge' }] });
    expect(revokesAccess(day(before), day(added))).toBe(false);

    const removed = octoberDay();
    removed.staff[1]!.events = [];
    expect(revokesAccess(day(before), day(removed))).toBe(true);

    const demoted = octoberDay();
    demoted.staff[0]!.events = [{ eventId: LC, role: 'judge' }];
    expect(revokesAccess(day(before), day(demoted))).toBe(true);

    const withoutVgc = octoberDay();
    withoutVgc.events = withoutVgc.events.filter((e) => e.id !== VGC);
    expect(revokesAccess(day(before), day(withoutVgc))).toBe(true);

    const relinked = octoberDay();
    relinked.staff[2]!.discordUserId = user(8);
    expect(revokesAccess(day(before), day(relinked))).toBe(true);
  });
});
