import { hasUnrestored, RESOURCE_PREFIX, snapshotOf, type Ledger, type ResourceRef, type SnapshotKind } from './ledger.js';

export type CleanupScope =
  | { kind: 'end-of-run'; runId: string }
  | { kind: 'run'; runId: string }
  | { kind: 'orphans' }
  | { kind: 'all' };

export type GuildSnapshot = {
  channels: { id: string; name: string; kind?: 'category' | 'channel' | 'thread' }[];
  roles: { id: string; name: string }[];
};

export type CleanupPlan = { delete: ResourceRef[]; restoreEveryone?: string; restoreGenieRole?: string };

const ORDER: Record<ResourceRef['kind'], number> = { thread: 0, channel: 1, category: 2, role: 3 };

const owned = (r: { name: string }) => r.name.startsWith(RESOURCE_PREFIX);

function restoresFrom(ledgers: Ledger[]): Pick<CleanupPlan, 'restoreEveryone' | 'restoreGenieRole'> {
  const oldest = (kind: SnapshotKind) =>
    [...ledgers].sort((a, b) => a.runId.localeCompare(b.runId)).find((l) => hasUnrestored(l, kind));
  const everyone = oldest('everyone');
  const genie = oldest('genieRole');
  return {
    ...(everyone ? { restoreEveryone: snapshotOf(everyone, 'everyone') } : {}),
    ...(genie ? { restoreGenieRole: snapshotOf(genie, 'genieRole') } : {}),
  };
}

function orphans(ledgers: Ledger[], guild: GuildSnapshot): ResourceRef[] {
  const known = new Set(ledgers.flatMap((l) => l.resources.map((r) => r.id)));
  return [
    ...guild.channels.filter((c) => owned(c) && !known.has(c.id)).map((c) => ({ kind: c.kind ?? 'channel', id: c.id, name: c.name })),
    ...guild.roles.filter((r) => owned(r) && !known.has(r.id)).map((r) => ({ kind: 'role' as const, id: r.id, name: r.name })),
  ];
}

/** Plans deletions and restores. Nothing without the `spike-` prefix is ever planned for deletion (NFR-1). */
export function planCleanup(scope: CleanupScope, ledgers: Ledger[], guild: GuildSnapshot): CleanupPlan {
  let resources: ResourceRef[] = [];
  let restores: Pick<CleanupPlan, 'restoreEveryone' | 'restoreGenieRole'> = {};

  if (scope.kind === 'end-of-run' || scope.kind === 'run') {
    const own = ledgers.find((l) => l.runId === scope.runId);
    if (own && !(scope.kind === 'end-of-run' && own.kept)) {
      resources = own.resources;
      restores = restoresFrom([own]);
    }
  } else if (scope.kind === 'orphans') {
    resources = orphans(ledgers, guild);
  } else {
    resources = [...ledgers.flatMap((l) => l.resources), ...orphans(ledgers, guild)];
    restores = restoresFrom(ledgers);
  }

  const toDelete = resources.filter(owned).sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return { delete: toDelete, ...restores };
}

export type DeleteOutcome = { status: number; code?: number };

export interface CleanupPort {
  deleteResource(ref: ResourceRef): Promise<DeleteOutcome>;
  restoreEveryone(bitfield: string): Promise<void>;
  restoreGenieRole(bitfield: string): Promise<void>;
}

export type CleanupResult = {
  ok: boolean;
  deleted: string[];
  alreadyGone: string[];
  failed: { id: string; status: number; code?: number }[];
};

const isGone = (o: DeleteOutcome) => o.status === 404 && (o.code === 10003 || o.code === 10011 || o.code === undefined);

export async function applyCleanup(plan: CleanupPlan, port: CleanupPort): Promise<CleanupResult> {
  const result: CleanupResult = { ok: true, deleted: [], alreadyGone: [], failed: [] };
  for (const ref of plan.delete) {
    const outcome = await port.deleteResource(ref);
    if (outcome.status >= 200 && outcome.status < 300) result.deleted.push(ref.id);
    else if (isGone(outcome)) result.alreadyGone.push(ref.id);
    else result.failed.push({ id: ref.id, ...outcome });
  }
  if (plan.restoreEveryone !== undefined) await port.restoreEveryone(plan.restoreEveryone);
  if (plan.restoreGenieRole !== undefined) await port.restoreGenieRole(plan.restoreGenieRole);
  result.ok = result.failed.length === 0;
  return result;
}
