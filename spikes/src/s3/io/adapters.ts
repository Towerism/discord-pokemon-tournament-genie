import { ChannelType, OverwriteType, type Client } from 'discord.js';
import { Api, fromBits, ok, toBits } from '../../io/rest.js';
import { createTracked, type LedgerHandle, type ResourceRef } from '../../shared/ledger.js';
import type { CleanupPort } from '../../shared/cleanup.js';
import type { ActPort, ArrangePort, ResolvedOverwrite, ThreadStatePort, WritePort } from '../ports.js';
import { NEW_EMOJI, EXISTING_EMOJI } from '../runner.js';
import { PERMISSIONS, type Action, type Outcome, type PermissionName } from '../types.js';

type ApiOverwrite = { id: string; type: number; allow: string; deny: string };

export const toApiOverwrites = (list: ResolvedOverwrite[]): ApiOverwrite[] =>
  list.map((o) => ({
    id: o.id,
    type: o.type === 'role' ? OverwriteType.Role : OverwriteType.Member,
    allow: toBits(o.allow),
    deny: toBits(o.deny),
  }));

export const fromApiOverwrites = (list: ApiOverwrite[]): ResolvedOverwrite[] =>
  list.map((o) => ({
    id: o.id,
    type: o.type === OverwriteType.Role ? 'role' : 'member',
    allow: fromBits(o.allow),
    deny: fromBits(o.deny),
  }));

const emojiPath = (e: string) => encodeURIComponent(e);

/** Arranges scenarios as the Administrator bot. Every resource it creates is ledgered first. */
export class ArrangeAdapter implements ArrangePort {
  private caseResources: ResourceRef[] = [];
  private seq = 0;

  constructor(
    private readonly api: Api,
    private readonly guildId: string,
    private readonly ledger: LedgerHandle,
    private readonly genieUserId: string,
  ) {}

  private name(base: string, suffix: string) {
    return `${base}-${suffix}`.slice(0, 100);
  }

  private async track(kind: ResourceRef['kind'], name: string, create: () => Promise<string>) {
    const id = await createTracked(this.ledger, { kind, name }, create);
    this.caseResources.push({ kind, id, name });
    return id;
  }

  async setEveryoneBase(perms: PermissionName[]) {
    await this.api.must('patch', `/guilds/${this.guildId}/roles/${this.guildId}`, { body: { permissions: toBits(perms) } });
  }

  async ensureRoles(roles: { key: string; aboveGenie?: boolean; permissions: string[] }[]) {
    const out: Record<string, string> = {};
    for (const r of roles) {
      const name = this.name(`spike-${this.ledger.data.runId}-${++this.seq}`, r.key.replace('role:', ''));
      out[r.key] = await this.track('role', name, async () => {
        const created = await this.api.must<{ id: string }>('post', `/guilds/${this.guildId}/roles`, {
          body: { name, permissions: toBits(r.permissions) },
        });
        return created.id;
      });
      if (r.aboveGenie) await this.placeAboveGenie(out[r.key]!);
    }
    return out;
  }

  private async placeAboveGenie(roleId: string) {
    const roles = await this.api.must<{ id: string; position: number; tags?: { bot_id?: string } }[]>('get', `/guilds/${this.guildId}/roles`);
    const genie = roles.find((r) => r.tags?.bot_id === this.genieUserId);
    if (!genie) throw new Error("genie's managed role not found");
    await this.api.must('patch', `/guilds/${this.guildId}/roles`, { body: [{ id: roleId, position: genie.position + 1 }] });
  }

  async ensureMemberRoles(userId: string, roleIds: string[]) {
    const [member, roles] = await Promise.all([
      this.api.must<{ roles: string[] }>('get', `/guilds/${this.guildId}/members/${userId}`),
      this.api.must<{ id: string; name: string }[]>('get', `/guilds/${this.guildId}/roles`),
    ]);
    const spike = new Set(roles.filter((r) => r.name.startsWith('spike-')).map((r) => r.id));
    const keep = member.roles.filter((id) => !spike.has(id));
    await this.api.must('patch', `/guilds/${this.guildId}/members/${userId}`, { body: { roles: [...keep, ...roleIds] } });
  }

  async createTarget(spec: { name: string; category: ResolvedOverwrite[] | null; rawUnderCategory: boolean; channelOverwrites: ResolvedOverwrite[] }) {
    let categoryId: string | undefined;
    if (spec.category) {
      const name = this.name(spec.name, 'cat');
      categoryId = await this.track('category', name, async () =>
        (
          await this.api.must<{ id: string }>('post', `/guilds/${this.guildId}/channels`, {
            body: { name, type: ChannelType.GuildCategory, permission_overwrites: toApiOverwrites(spec.category!) },
          })
        ).id,
      );
    }
    const channelId = await this.track('channel', spec.name, async () =>
      (
        await this.api.must<{ id: string }>('post', `/guilds/${this.guildId}/channels`, {
          body: {
            name: spec.name,
            type: ChannelType.GuildText,
            ...(categoryId ? { parent_id: categoryId } : {}),
            // R8 omits the field entirely, so whatever Discord does at create is what gets recorded.
            ...(spec.rawUnderCategory ? {} : { permission_overwrites: toApiOverwrites(spec.channelOverwrites) }),
          },
        })
      ).id,
    );
    return { channelId, ...(categoryId ? { categoryId } : {}) };
  }

  async createParentCategory(name: string, overwrites: ResolvedOverwrite[]) {
    return this.track('category', name, async () =>
      (
        await this.api.must<{ id: string }>('post', `/guilds/${this.guildId}/channels`, {
          body: { name, type: ChannelType.GuildCategory, permission_overwrites: toApiOverwrites(overwrites) },
        })
      ).id,
    );
  }

  async createThread(channelId: string, variant: string, memberIds: string[]) {
    const isPrivate = variant.startsWith('private');
    const name = `spike-${this.ledger.data.runId}-t${++this.seq}`;
    const threadId = await this.track('thread', name, async () =>
      (
        await this.api.must<{ id: string }>('post', `/channels/${channelId}/threads`, {
          body: { name, type: isPrivate ? ChannelType.PrivateThread : ChannelType.PublicThread, invitable: false, auto_archive_duration: 10080 },
        })
      ).id,
    );
    if (isPrivate) {
      for (const userId of memberIds) await this.api.must('put', `/channels/${threadId}/thread-members/${userId}`);
    }
    return threadId;
  }

  async seedMessage(targetId: string, emoji: string) {
    const m = await this.api.must<{ id: string }>('post', `/channels/${targetId}/messages`, { body: { content: 'S3 seed message' } });
    await this.api.must('put', `/channels/${targetId}/messages/${m.id}/reactions/${emojiPath(emoji)}/@me`);
    return m.id;
  }

  async archiveThread(threadId: string) {
    await this.api.must('patch', `/channels/${threadId}`, { body: { archived: true } });
  }

  async teardownCase() {
    const order = { thread: 0, channel: 1, category: 2, role: 3 } as const;
    const resources = [...this.caseResources].sort((a, b) => order[a.kind] - order[b.kind]);
    this.caseResources = [];
    for (const r of resources) {
      const route = r.kind === 'role' ? (`/guilds/${this.guildId}/roles/${r.id}` as const) : (`/channels/${r.id}` as const);
      await this.api.call('delete', route); // already-gone is fine; end-of-run cleanup retries anything left
    }
  }
}

/** Genie's own writes, read back through the Administrator (genie may not see every channel). */
export class WriteAdapter implements WritePort {
  constructor(
    private readonly genie: Api,
    private readonly arranger: Api,
    private readonly genieClient: Client,
    private readonly guildId: string,
    private readonly ledger: LedgerHandle,
  ) {}

  writeOverwrites(channelId: string, overwrites: ResolvedOverwrite[]): Promise<Outcome> {
    // Modify Channel with `permission_overwrites` is a full replace, as discord.js's `permissionOverwrites.set` does.
    return this.genie.call('patch', `/channels/${channelId}`, { body: { permission_overwrites: toApiOverwrites(overwrites) } });
  }

  async createWithOverwrites(spec: { kind: 'category' | 'channel'; name: string; parentId?: string; overwrites: ResolvedOverwrite[] }) {
    let outcome: Outcome = { kind: 'network', message: 'not attempted' };
    let id: string | undefined;
    try {
      id = await createTracked(this.ledger, { kind: spec.kind === 'category' ? 'category' : 'channel', name: spec.name }, async () => {
        outcome = await this.genie.call('post', `/guilds/${this.guildId}/channels`, {
          body: {
            name: spec.name,
            type: spec.kind === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText,
            ...(spec.parentId ? { parent_id: spec.parentId } : {}),
            permission_overwrites: toApiOverwrites(spec.overwrites),
          },
        });
        if (!ok(outcome)) throw new Error('refused');
        return (outcome as { body: { id: string } }).body.id;
      });
    } catch {
      return { outcome };
    }
    return { outcome, id };
  }

  async readOverwrites(channelId: string) {
    const ch = await this.arranger.must<{ permission_overwrites?: ApiOverwrite[] }>('get', `/channels/${channelId}`);
    return fromApiOverwrites(ch.permission_overwrites ?? []);
  }

  async libraryPermissions(targetId: string, userId: string) {
    const guild = await this.genieClient.guilds.fetch({ guild: this.guildId, force: true });
    await guild.roles.fetch(undefined, { force: true });
    const member = await guild.members.fetch({ user: userId, force: true });
    const channel = await this.genieClient.channels.fetch(targetId, { force: true });
    if (!channel || !('permissionsFor' in channel)) throw new Error(`channel ${targetId} has no permissions`);
    if ('parentId' in channel && channel.parentId) await this.genieClient.channels.fetch(channel.parentId, { force: true });
    const perms = (channel as { permissionsFor(m: unknown): { has(p: string, checkAdmin?: boolean): boolean } | null }).permissionsFor(member);
    return Object.fromEntries(PERMISSIONS.map((p) => [p, perms?.has(p, true) ?? false])) as Record<PermissionName, boolean>;
  }
}

/** The subject probe tries each action for real; threads it manages to create are ledgered. */
export class ActAdapter implements ActPort {
  private seq = 0;
  constructor(
    private readonly api: Api,
    private readonly ledger: LedgerHandle,
  ) {}

  async attempt(action: Action, targetId: string, seededMessageId: string): Promise<Outcome> {
    switch (action) {
      case 'view':
        return this.api.call('get', `/channels/${targetId}`);
      case 'readHistory':
        return this.api.call('get', `/channels/${targetId}/messages`, { query: new URLSearchParams({ limit: '50' }) });
      case 'reactExisting':
        return this.api.call('put', `/channels/${targetId}/messages/${seededMessageId}/reactions/${emojiPath(EXISTING_EMOJI)}/@me`);
      case 'reactNew':
        return this.api.call('put', `/channels/${targetId}/messages/${seededMessageId}/reactions/${emojiPath(NEW_EMOJI)}/@me`);
      case 'send':
        return this.api.call('post', `/channels/${targetId}/messages`, { body: { content: 'S3 probe' } });
      case 'createPublicThread':
      case 'createPrivateThread': {
        const name = `spike-${this.ledger.data.runId}-probe${++this.seq}`;
        let outcome: Outcome = { kind: 'network', message: 'not attempted' };
        await createTracked(this.ledger, { kind: 'thread', name }, async () => {
          outcome = await this.api.call('post', `/channels/${targetId}/threads`, {
            body: { name, type: action === 'createPublicThread' ? ChannelType.PublicThread : ChannelType.PrivateThread },
          });
          if (!ok(outcome)) throw new Error('refused');
          return (outcome as { body: { id: string } }).body.id;
        }).catch(() => undefined);
        return outcome;
      }
    }
  }
}

export class ThreadStateAdapter implements ThreadStatePort {
  constructor(private readonly api: Api) {}
  async isArchived(threadId: string) {
    const t = await this.api.must<{ thread_metadata?: { archived?: boolean } }>('get', `/channels/${threadId}`);
    return t.thread_metadata?.archived ?? false;
  }
}

export class CleanupAdapter implements CleanupPort {
  constructor(
    private readonly api: Api,
    private readonly guildId: string,
    private readonly genieUserId: string,
  ) {}

  async deleteResource(ref: ResourceRef) {
    const route = ref.kind === 'role' ? (`/guilds/${this.guildId}/roles/${ref.id}` as const) : (`/channels/${ref.id}` as const);
    const o = await this.api.call('delete', route);
    return o.kind === 'http' ? { status: o.status === 200 ? 204 : o.status, ...(o.code !== undefined ? { code: o.code } : {}) } : { status: 0 };
  }

  async restoreEveryone(bitfield: string) {
    await this.api.must('patch', `/guilds/${this.guildId}/roles/${this.guildId}`, { body: { permissions: bitfield } });
  }

  async restoreGenieRole(bitfield: string) {
    const id = await genieRoleId(this.api, this.guildId, this.genieUserId);
    await this.api.must('patch', `/guilds/${this.guildId}/roles/${id}`, { body: { permissions: bitfield } });
  }
}

export async function genieRoleId(api: Api, guildId: string, genieUserId: string): Promise<string> {
  const roles = await api.must<{ id: string; tags?: { bot_id?: string } }[]>('get', `/guilds/${guildId}/roles`);
  const role = roles.find((r) => r.tags?.bot_id === genieUserId);
  if (!role) throw new Error("genie's managed role not found");
  return role.id;
}
