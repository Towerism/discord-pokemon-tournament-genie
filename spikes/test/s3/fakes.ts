import type { ResolvedOverwrite, RunContext, RunnerPorts } from '../../src/s3/ports.js';
import { PERMISSIONS, type Action, type Outcome, type PermissionName } from '../../src/s3/types.js';

export const ctx: RunContext = {
  guildId: '1300000000000000001',
  runId: '20261013120000-0a1f',
  members: { subject: '1300000000000000020', other: '1300000000000000021', genie: '1300000000000000022' },
  genieRolePermissions: ['ManageChannels', 'ManageRoles', 'ViewChannel'],
};

export const ok = (status = 200, body?: unknown): Outcome => ({ kind: 'http', status, body });
export const denied: Outcome = { kind: 'http', status: 403, code: 50013 };
export const flaky: Outcome = { kind: 'http', status: 500 };
export const archivedBlock: Outcome = { kind: 'http', status: 400, code: 50083 };

export type FakeOptions = {
  /** Scripted outcomes per action; each attempt takes the next one, the last one repeats. */
  act?: Partial<Record<Action, Outcome[]>>;
  /** Refuse a full-replace write when it is the n-th write (1-based) of the case. */
  refuseWrite?: number;
  /** Read-back mutation: Discord stores something other than what was written. */
  storeDifferently?: (written: ResolvedOverwrite[]) => ResolvedOverwrite[];
  /** Create-path outcome for write cases, by kind and the case's channel name. */
  createOutcome?: (kind: 'category' | 'channel', name: string) => Outcome;
  /** Edit-path outcome for write cases, keyed by the case's channel name fragment. */
  refuseEditFor?: (channelName: string) => boolean;
  library?: Partial<Record<PermissionName, boolean>>;
};

/**
 * An in-memory stand-in for the four ports. It keeps real state (overwrites per channel, thread
 * archive state, seeded messages), so tests assert on what the runner recorded, not on calls.
 */
export function fakePorts(opts: FakeOptions = {}) {
  let nextId = 1300000000000001000n;
  const id = () => (nextId++).toString();
  const overwrites = new Map<string, ResolvedOverwrite[]>();
  const channelNames = new Map<string, string>();
  const archived = new Map<string, boolean>();
  const seeded = new Map<string, string>();
  const attempts: Action[] = [];
  let writesThisCase = 0;
  let teardowns = 0;
  const cursor = new Map<Action, number>();
  const creates: { kind: 'category' | 'channel'; name: string; parentId?: string }[] = [];

  const ports: RunnerPorts = {
    arrange: {
      async setEveryoneBase() {},
      async ensureRoles(roles) {
        return Object.fromEntries(roles.map((r) => [r.key, id()]));
      },
      async ensureMemberRoles() {},
      async createTarget(spec) {
        const channelId = id();
        channelNames.set(channelId, spec.name);
        overwrites.set(channelId, spec.rawUnderCategory ? (spec.category ?? []) : spec.channelOverwrites);
        return { channelId, ...(spec.category ? { categoryId: id() } : {}) };
      },
      async createParentCategory() {
        return id();
      },
      async createThread(_channelId, variant) {
        const t = id();
        archived.set(t, false);
        return t + (variant.startsWith('private') ? '' : '');
      },
      async seedMessage(targetId) {
        const m = id();
        seeded.set(targetId, m);
        return m;
      },
      async archiveThread(threadId) {
        archived.set(threadId, true);
      },
      async teardownCase() {
        teardowns++;
        writesThisCase = 0;
        cursor.clear();
      },
    },
    write: {
      async writeOverwrites(channelId, list) {
        writesThisCase++;
        if (opts.refuseWrite === writesThisCase) return denied;
        if (opts.refuseEditFor?.(channelNames.get(channelId) ?? '')) return denied;
        overwrites.set(channelId, opts.storeDifferently ? opts.storeDifferently(list) : list);
        return ok(204);
      },
      async createWithOverwrites(spec) {
        creates.push({ kind: spec.kind, name: spec.name, ...(spec.parentId ? { parentId: spec.parentId } : {}) });
        const outcome = opts.createOutcome?.(spec.kind, spec.name) ?? ok(201);
        if (outcome.kind === 'http' && outcome.status >= 300) return { outcome };
        const created = id();
        channelNames.set(created, spec.name);
        overwrites.set(created, opts.storeDifferently ? opts.storeDifferently(spec.overwrites) : spec.overwrites);
        return { outcome, id: created };
      },
      async readOverwrites(channelId) {
        return overwrites.get(channelId) ?? [];
      },
      async libraryPermissions() {
        return Object.fromEntries(PERMISSIONS.map((p) => [p, opts.library?.[p] ?? true])) as Record<PermissionName, boolean>;
      },
    },
    act: {
      async attempt(action, targetId, seededMessageId) {
        attempts.push(action);
        const script = opts.act?.[action] ?? [action === 'readHistory' ? ok(200, [{ id: seededMessageId }]) : ok()];
        const i = cursor.get(action) ?? 0;
        cursor.set(action, i + 1);
        const outcome = script[Math.min(i, script.length - 1)]!;
        // Like Discord: a successful send in an archived thread unarchives it.
        if (action === 'send' && outcome.kind === 'http' && outcome.status < 300 && archived.has(targetId)) archived.set(targetId, false);
        return outcome;
      },
    },
    threadState: {
      async isArchived(threadId) {
        return archived.get(threadId) ?? false;
      },
    },
  };
  return { ports, attempts, teardowns: () => teardowns, overwrites, creates };
}
