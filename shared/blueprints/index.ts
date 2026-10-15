/**
 * Blueprints → the desired channels of a day (ADR-0005). Pure: the preview, the provisioning job and `canSee()`
 * (ADR-0010) all read the same plan, so Discord and the website can't disagree.
 */
import { type Overwrite, everyone, member, role } from '../discord/overwrites';
import { PERMISSION_BITS as P } from '../discord/permissions';

export type Scope = 'day' | 'per_event';
export type Audience = 'all_staff' | 'event_staff' | 'head_judges';
export type Purpose = 'general' | 'floor' | 'penalties';
export type ChannelKind = 'text' | 'voice';
export type EventRole = 'headjudge' | 'judge' | 'scorekeeper' | 'administration' | 'translator';
export type LinkState = 'unlinked' | 'claimed' | 'linked';

export interface BlueprintChannelInput {
  key: string;
  scope: Scope;
  kind: ChannelKind;
  namePattern: string;
  audience: Audience;
  purpose: Purpose;
  topic: string | null;
  position: number;
}

export interface BlueprintInput {
  name: string;
  categoryNamePattern: string;
  channels: BlueprintChannelInput[];
}

/** §6.2's default blueprint, seeded by the M2 migration. */
export const DEFAULT_BLUEPRINT: BlueprintInput = {
  name: 'Standard day',
  categoryNamePattern: '🏆 {weekday} {date} · {title}',
  channels: [
    { key: 'day-staff', scope: 'day', kind: 'text', namePattern: 'day-staff', audience: 'all_staff', purpose: 'general', topic: null, position: 0 },
    { key: 'head-judges', scope: 'day', kind: 'text', namePattern: 'head-judges', audience: 'head_judges', purpose: 'general', topic: null, position: 1 },
    { key: 'floor', scope: 'per_event', kind: 'text', namePattern: '{slug}-floor', audience: 'event_staff', purpose: 'floor', topic: null, position: 2 },
    { key: 'penalties', scope: 'per_event', kind: 'text', namePattern: '{slug}-penalties', audience: 'event_staff', purpose: 'penalties', topic: null, position: 3 },
  ],
};

export const MAX_DAY_CHANNELS = 10;
export const MAX_EVENT_CHANNELS = 8;
const TOKENS = ['slug', 'event', 'title', 'date', 'weekday'] as const;
const KEY = /^[a-z0-9-]{1,32}$/;

export interface BlueprintProblem {
  path: string;
  code:
    | 'audience_not_allowed'
    | 'slug_required'
    | 'event_token_in_day_channel'
    | 'unknown_token'
    | 'voice_not_supported'
    | 'duplicate_key'
    | 'invalid_key'
    | 'too_many_day_channels'
    | 'too_many_event_channels';
}

const tokensIn = (pattern: string) => [...pattern.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);

/** The audience rules of §6.2: a blueprint can never widen a per-event channel. */
export function validateBlueprint(b: BlueprintInput): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  if (tokensIn(b.categoryNamePattern).some((t) => !(TOKENS as readonly string[]).includes(t) || t === 'slug' || t === 'event')) {
    problems.push({ path: 'categoryNamePattern', code: 'unknown_token' });
  }
  const keys = new Set<string>();
  b.channels.forEach((c, i) => {
    const at = (field: string) => `channels.${i}.${field}`;
    if (!KEY.test(c.key)) problems.push({ path: at('key'), code: 'invalid_key' });
    else if (keys.has(c.key)) problems.push({ path: at('key'), code: 'duplicate_key' });
    keys.add(c.key);
    if (c.kind !== 'text') problems.push({ path: at('kind'), code: 'voice_not_supported' });
    const allowed: Audience[] = c.scope === 'day' ? ['all_staff', 'head_judges'] : ['event_staff', 'head_judges'];
    if (!allowed.includes(c.audience)) problems.push({ path: at('audience'), code: 'audience_not_allowed' });
    const tokens = tokensIn(c.namePattern);
    if (tokens.some((t) => !(TOKENS as readonly string[]).includes(t)) || (c.topic !== null && tokensIn(c.topic).some((t) => !(TOKENS as readonly string[]).includes(t)))) {
      problems.push({ path: at('namePattern'), code: 'unknown_token' });
    } else if (c.scope === 'per_event' && !tokens.includes('slug')) {
      problems.push({ path: at('namePattern'), code: 'slug_required' });
    } else if (c.scope === 'day' && (tokens.includes('slug') || tokens.includes('event'))) {
      problems.push({ path: at('namePattern'), code: 'event_token_in_day_channel' });
    }
  });
  if (b.channels.filter((c) => c.scope === 'day').length > MAX_DAY_CHANNELS) problems.push({ path: 'channels', code: 'too_many_day_channels' });
  if (b.channels.filter((c) => c.scope === 'per_event').length > MAX_EVENT_CHANNELS) problems.push({ path: 'channels', code: 'too_many_event_channels' });
  return problems;
}

export interface PlanInput {
  day: { id: number; date: string; title: string };
  events: { id: number; name: string; slug: string; startsAt: number; gameConfirmed: boolean }[];
  staff: { staffMemberId: number; discordUserId: string | null; linkState: LinkState; events: { eventId: number; role: EventRole }[] }[];
}

export interface DesiredContext {
  guildId: string;
  botUserId: string;
  organizerRoleId: string;
  /** Members holding the mapped head-judge role (empty when unknown). */
  headJudgeRoleHolders: ReadonlySet<string>;
  /** The guild's members, or `null` when not checked: then nobody is dropped for having left. */
  guildMemberIds: ReadonlySet<string> | null;
}

export type PlanProblem =
  | { code: 'unlinked_staff'; staffMemberIds: number[] }
  | { code: 'unconfirmed_game'; eventIds: number[] }
  | { code: 'duplicate_channel_name'; name: string; keys: string[] };

export interface AudienceMember {
  staffMemberId: number;
  discordUserId: string;
}

export interface DesiredChannel {
  key: string;
  eventId: number | null;
  purpose: Purpose;
  name: string;
  topic: string | null;
  audience: AudienceMember[];
  overwrites: Overwrite[];
}

export interface DesiredDay {
  category: { name: string; overwrites: Overwrite[] };
  channels: DesiredChannel[];
  problems: PlanProblem[];
}

const BOT_ALLOW = P.ViewChannel | P.SendMessages | P.ManageChannels;
export const STAFF_ALLOW = P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.AttachFiles;

/** The overwrites on the category and every channel before any member's: `@everyone` denied, the bot and the organizer role allowed. */
export function baseOverwrites(c: Pick<DesiredContext, 'guildId' | 'botUserId' | 'organizerRoleId'>): Overwrite[] {
  return [everyone(c.guildId, { deny: P.ViewChannel }), member(c.botUserId, { allow: BOT_ALLOW }), role(c.organizerRoleId, { allow: P.ViewChannel })];
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `{weekday}` and `{date}` of a store-TZ calendar date, independent of the process time zone. */
export function dateTokens(date: string): { weekday: string; date: string } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return { weekday: WEEKDAYS[at.getUTCDay()]!, date: `${MONTHS[m - 1]} ${d}` };
}

type Vars = Record<(typeof TOKENS)[number], string>;

/** Fills a pattern. Text channel names are normalized as Discord does; a category keeps its spelling. */
export function formatName(pattern: string, vars: Vars, kind: 'text' | 'category'): string {
  const filled = pattern.replace(/\{([^}]*)\}/g, (_, t: string) => (Object.hasOwn(vars, t) ? vars[t as keyof Vars] : ''));
  if (kind === 'category') return filled.trim().slice(0, 100);
  return filled
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}

const fillTopic = (topic: string | null, vars: Vars) => (topic === null ? null : topic.replace(/\{([^}]*)\}/g, (_, t: string) => (Object.hasOwn(vars, t) ? vars[t as keyof Vars] : '')));

export function desiredChannels(plan: PlanInput, blueprint: BlueprintInput, ctx: DesiredContext): DesiredDay {
  const base = baseOverwrites(ctx);
  const day = { title: plan.day.title, ...dateTokens(plan.day.date) };
  const eligible = plan.staff
    .filter((s): s is typeof s & { discordUserId: string } => s.linkState === 'linked' && s.discordUserId !== null)
    .filter((s) => ctx.guildMemberIds === null || ctx.guildMemberIds.has(s.discordUserId));
  const events = [...plan.events].sort((a, b) => a.startsAt - b.startsAt || a.name.localeCompare(b.name) || a.id - b.id);
  const ordered = (scope: Scope) => blueprint.channels.filter((c) => c.scope === scope).sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));

  const dayHeadJudge = (s: (typeof eligible)[number]) => s.events.some((e) => e.role === 'headjudge') || ctx.headJudgeRoleHolders.has(s.discordUserId);
  const audienceOf = (c: BlueprintChannelInput, eventId: number | null): AudienceMember[] => {
    const inAudience = (s: (typeof eligible)[number]) => {
      if (eventId === null) return c.audience === 'all_staff' || dayHeadJudge(s);
      return s.events.some((e) => e.eventId === eventId && (c.audience === 'event_staff' || e.role === 'headjudge'));
    };
    return eligible
      .filter(inAudience)
      .map((s) => ({ staffMemberId: s.staffMemberId, discordUserId: s.discordUserId }))
      .sort((a, b) => a.staffMemberId - b.staffMemberId);
  };
  const build = (c: BlueprintChannelInput, eventId: number | null, vars: Vars): DesiredChannel => {
    const audience = audienceOf(c, eventId);
    const members = [...audience].sort((a, b) => (a.discordUserId < b.discordUserId ? -1 : 1)).map((a) => member(a.discordUserId, { allow: STAFF_ALLOW }));
    return { key: c.key, eventId, purpose: c.purpose, name: formatName(c.namePattern, vars, 'text'), topic: fillTopic(c.topic, vars), audience, overwrites: [...base, ...members] };
  };

  const dayVars: Vars = { ...day, slug: '', event: '' };
  const channels = [
    ...ordered('day').map((c) => build(c, null, dayVars)),
    ...events.flatMap((e) => ordered('per_event').map((c) => build(c, e.id, { ...day, slug: e.slug, event: e.name }))),
  ];

  const problems: PlanProblem[] = [];
  const unlinked = plan.staff.filter((s) => s.linkState !== 'linked').map((s) => s.staffMemberId);
  if (unlinked.length) problems.push({ code: 'unlinked_staff', staffMemberIds: unlinked });
  const unconfirmed = plan.events.filter((e) => !e.gameConfirmed).map((e) => e.id);
  if (unconfirmed.length) problems.push({ code: 'unconfirmed_game', eventIds: unconfirmed });
  const byName = new Map<string, string[]>();
  for (const c of channels) byName.set(c.name, [...(byName.get(c.name) ?? []), c.key]);
  for (const [name, keys] of byName) if (keys.length > 1) problems.push({ code: 'duplicate_channel_name', name, keys: [...new Set(keys)].sort() });

  return { category: { name: formatName(blueprint.categoryNamePattern, dayVars, 'category'), overwrites: base }, channels, problems };
}

const channelId = (c: DesiredChannel) => `${c.eventId ?? 0}:${c.key}`;

/** True when anyone who could see a desired channel before can't after (ADR-0005: removals sync at once). */
export function revokesAccess(before: DesiredDay, after: DesiredDay): boolean {
  const now = new Map(after.channels.map((c) => [channelId(c), new Set(c.audience.map((a) => a.discordUserId))]));
  return before.channels.some((c) => {
    const users = now.get(channelId(c)) ?? new Set<string>();
    return c.audience.some((a) => !users.has(a.discordUserId));
  });
}

/** A unique slug from an event's name: ASCII letters and digits, dashes between, at most 32. */
export function deriveSlug(name: string, taken: readonly string[]): string {
  const strip = (s: string) => s.replace(/^-+|-+$/g, '');
  const base = strip(strip(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 29)) || 'event';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
