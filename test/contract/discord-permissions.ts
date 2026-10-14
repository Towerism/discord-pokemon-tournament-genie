/**
 * Spike S3's recorded real-guild permission cases as one table-driven contract suite (architecture §11,
 * ADR-0003). Every subject that implements the port runs the same table: the in-memory fake in CI, and the
 * discord.js adapter on a test guild before each release. The fixture is read as is; a case only changes
 * together with a real-guild observation.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Overwrite, canonical } from '../../shared/discord/overwrites';
import { PERMISSION_BITS, type PermissionName, bitsOf } from '../../shared/discord/permissions';
import { type DiscordGateway, DiscordPermissionError } from '../../server/modules/discord/port';

/** The fixture's own shapes (`cases.v1.schema.json`). */
export interface CaseOverwrite {
  target: string;
  allow: string[];
  deny: string[];
  allowOther: string[];
  denyOther: string[];
}
export interface WriteCase {
  kind: 'write';
  id: string;
  path: 'create' | 'edit';
  result: 'ok' | 'refused';
  context: { everyone: string[]; genieRole: string[]; overwritesBefore: CaseOverwrite[] };
  attempted: CaseOverwrite[];
  stored?: CaseOverwrite[];
}
export interface EffectiveCase {
  kind: 'effective';
  id: string;
  guild: { everyone: string[]; roles: { key: string; permissions: string[]; position: number }[] };
  subject: { key: string; roles: string[] };
  other: { key: string; roles: string[] };
  category: { overwrites: CaseOverwrite[] } | null;
  channel: { createdUnderCategoryWithoutOverwrites: boolean; overwrites: CaseOverwrite[] };
  thread: { type: 'public' | 'private'; archived: boolean; subjectIsMember: boolean } | null;
  effective: Record<string, boolean | 'unobservable'>;
}
export type PermissionCase = WriteCase | EffectiveCase;

export function loadCases(): PermissionCase[] {
  const url = new URL('../fixtures/discord-permissions/cases.v1.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { cases: PermissionCase[] }).cases;
}

/** The guild a case runs in: `@everyone`'s base, the roles by key, and the bot's role permissions. */
export interface CaseGuild {
  everyone: bigint;
  roles: { key: string; permissions: bigint; position: number }[];
  /** Member keys (`member:subject`, `member:other`) and their role keys. */
  members: { key: string; roles: string[] }[];
  genieRole: bigint;
}

/** One case's world on a subject. Every ID a case names is a symbolic key until `id()` maps it. */
export interface SubjectWorld {
  gateway: DiscordGateway;
  guildId: string;
  /** `everyone`, `member:genie`, `member:<name>`, `role:<name>` → the subject's Discord ID. */
  id(key: string): string;
  /** A category to hold a case's channel when the case has none of its own. */
  parent(): Promise<string>;
  /** Puts overwrites on a channel the way an administrator would, bypassing the bot's limits (S3 `W7`). */
  placeAsAdmin(channelId: string, overwrites: Overwrite[]): Promise<void>;
  addThread(channelId: string, thread: { type: 'public' | 'private'; archived: boolean; memberKeys: string[] }): Promise<string>;
  /** The member's effective permissions in the channel (or thread). */
  effective(memberKey: string, channelId: string, threadId?: string): Promise<bigint>;
  cleanup(): Promise<void>;
}

export interface PermissionSubject {
  name: string;
  /** `null` when this subject can't run the case; the reason is printed as a skip. */
  world(guild: CaseGuild, c: PermissionCase): Promise<SubjectWorld | { skip: string }>;
}

const TRACKED = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
] as const satisfies readonly PermissionName[];

export function toOverwrite(o: CaseOverwrite, id: (key: string) => string): Overwrite {
  const allow = bitsOf([...o.allow, ...o.allowOther]);
  const deny = bitsOf([...o.deny, ...o.denyOther]);
  if (o.target === 'everyone') return { target: { kind: 'everyone' }, allow, deny };
  const [kind] = o.target.split(':');
  return { target: { kind: kind === 'role' ? 'role' : 'member', id: id(o.target) }, allow, deny };
}

export function caseGuild(c: PermissionCase): CaseGuild {
  if (c.kind === 'write') {
    const keys = new Set<string>();
    for (const o of [...c.attempted, ...c.context.overwritesBefore, ...(c.stored ?? [])]) keys.add(o.target);
    return {
      everyone: bitsOf(c.context.everyone),
      roles: [...keys].filter((k) => k.startsWith('role:')).map((key, i) => ({ key, permissions: 0n, position: i + 1 })),
      members: [...keys].filter((k) => k.startsWith('member:') && k !== 'member:genie').map((key) => ({ key, roles: [] })),
      genieRole: bitsOf(c.context.genieRole),
    };
  }
  return {
    everyone: bitsOf(c.guild.everyone),
    roles: c.guild.roles.map((r) => ({ key: r.key, permissions: bitsOf(r.permissions), position: r.position })),
    members: [c.subject, c.other],
    // S3 recorded every effective case with `genie` holding exactly the 13 invite permissions.
    genieRole: bitsOf([
      'AddReactions',
      'AttachFiles',
      'CreatePrivateThreads',
      'CreatePublicThreads',
      'EmbedLinks',
      'ManageChannels',
      'ManageRoles',
      'ManageThreads',
      'ReadMessageHistory',
      'SendMessages',
      'SendMessagesInThreads',
      'UseApplicationCommands',
      'ViewChannel',
    ]),
  };
}

async function runWrite(world: SubjectWorld, c: WriteCase): Promise<void> {
  const ow = (list: CaseOverwrite[]) => list.map((o) => toOverwrite(o, (k) => world.id(k)));
  const attempt = async (): Promise<string> => {
    if (c.path === 'create' && c.id.endsWith('createcategory')) {
      return world.gateway.createCategory(world.guildId, { name: `case-${c.id}`.toLowerCase(), overwrites: ow(c.attempted) });
    }
    const parentId = await world.parent();
    if (c.path === 'create') {
      return world.gateway.createChannel(world.guildId, { name: `case-${c.id}`.toLowerCase(), parentId, overwrites: ow(c.attempted) });
    }
    const channelId = await world.gateway.createChannel(world.guildId, { name: `case-${c.id}`.toLowerCase(), parentId, overwrites: [] });
    if (c.context.overwritesBefore.length > 0) await world.placeAsAdmin(channelId, ow(c.context.overwritesBefore));
    await world.gateway.setOverwrites(channelId, ow(c.attempted));
    return channelId;
  };

  let channelId: string | null = null;
  let refused = false;
  try {
    channelId = await attempt();
  } catch (err) {
    if (!(err instanceof DiscordPermissionError)) throw err;
    refused = true;
  }
  expect(refused ? 'refused' : 'ok', c.id).toBe(c.result);
  if (c.result === 'ok' && c.stored) {
    const read = await world.gateway.getChannel(channelId!);
    expect(canonical(read!.overwrites), c.id).toEqual(canonical(ow(c.stored)));
  }
}

async function runEffective(world: SubjectWorld, c: EffectiveCase): Promise<void> {
  const ow = (list: CaseOverwrite[]) => list.map((o) => toOverwrite(o, (k) => world.id(k)));
  let parentId: string;
  if (c.category) {
    parentId = await world.gateway.createCategory(world.guildId, { name: `case-${c.id}`.toLowerCase(), overwrites: [] });
    await world.placeAsAdmin(parentId, ow(c.category.overwrites));
  } else {
    parentId = await world.parent();
  }
  let channelId: string;
  if (c.channel.createdUnderCategoryWithoutOverwrites) {
    channelId = await world.gateway.createChannel(world.guildId, { name: `case-${c.id}`.toLowerCase(), parentId });
  } else {
    channelId = await world.gateway.createChannel(world.guildId, { name: `case-${c.id}`.toLowerCase(), parentId, overwrites: [] });
    await world.placeAsAdmin(channelId, ow(c.channel.overwrites));
  }
  const threadId = c.thread
    ? await world.addThread(channelId, { type: c.thread.type, archived: c.thread.archived, memberKeys: c.thread.subjectIsMember ? [c.subject.key] : [] })
    : undefined;
  const bits = await world.effective(c.subject.key, channelId, threadId);
  for (const name of TRACKED) {
    const want = c.effective[name];
    if (want === 'unobservable' || want === undefined) continue;
    expect((bits & PERMISSION_BITS[name]) !== 0n, `${c.id}: ${name}`).toBe(want);
  }
}

/** Registers the whole table for one subject. */
export function describePermissionContract(subject: PermissionSubject, cases: PermissionCase[] = loadCases()): void {
  describe(`S3 permission contract: ${subject.name}`, () => {
    for (const c of cases) {
      it(`${c.id} (${c.kind})`, async (ctx) => {
        const world = await subject.world(caseGuild(c), c);
        if ('skip' in world) {
          ctx.skip(world.skip);
          return;
        }
        try {
          if (c.kind === 'write') await runWrite(world, c);
          else await runEffective(world, c);
        } finally {
          await world.cleanup();
        }
      });
    }
  });
}
