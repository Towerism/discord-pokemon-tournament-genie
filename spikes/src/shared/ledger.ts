import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ResourceKind = 'category' | 'channel' | 'thread' | 'role';
export type ResourceRef = { kind: ResourceKind; id: string; name: string };
export type SnapshotKind = 'everyone' | 'genieRole';

export type Ledger = {
  runId: string;
  guildId: string;
  kept: boolean;
  /** Bitfields captured before the harness changed them. */
  everyoneBaseSnapshot?: string;
  genieRoleSnapshot?: string;
  restored: SnapshotKind[];
  resources: ResourceRef[];
};

export type LedgerHandle = { path: string; data: Ledger };

export const RESOURCE_PREFIX = 'spike-';

async function persist(handle: LedgerHandle): Promise<void> {
  const tmp = `${handle.path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(handle.data, null, 2)}\n`, 'utf8');
  await rename(tmp, handle.path);
}

export async function createLedger(
  dir: string,
  init: { runId: string; guildId: string; kept: boolean },
): Promise<LedgerHandle> {
  await mkdir(dir, { recursive: true });
  const handle = { path: join(dir, `ledger-${init.runId}.json`), data: { ...init, restored: [], resources: [] } };
  await persist(handle);
  return handle;
}

/**
 * Creates a resource and records it before anything else happens, so a crash afterwards
 * still leaves it findable by cleanup.
 */
export async function createTracked(
  handle: LedgerHandle,
  spec: { kind: ResourceKind; name: string },
  create: () => Promise<string>,
): Promise<string> {
  const prefix = `${RESOURCE_PREFIX}${handle.data.runId}-`;
  if (!spec.name.startsWith(prefix)) throw new Error(`resource name must start with the run prefix ${prefix}`);
  const id = await create();
  handle.data.resources.push({ kind: spec.kind, id, name: spec.name });
  await persist(handle);
  return id;
}

export async function recordSnapshot(handle: LedgerHandle, kind: SnapshotKind, bitfield: string): Promise<void> {
  if (kind === 'everyone') handle.data.everyoneBaseSnapshot = bitfield;
  else handle.data.genieRoleSnapshot = bitfield;
  handle.data.restored = handle.data.restored.filter((k) => k !== kind);
  await persist(handle);
}

export async function markRestored(handle: LedgerHandle, kind: SnapshotKind): Promise<void> {
  if (!handle.data.restored.includes(kind)) handle.data.restored.push(kind);
  await persist(handle);
}

export function snapshotOf(ledger: Ledger, kind: SnapshotKind): string | undefined {
  return kind === 'everyone' ? ledger.everyoneBaseSnapshot : ledger.genieRoleSnapshot;
}

export function hasUnrestored(ledger: Ledger, kind: SnapshotKind): boolean {
  return snapshotOf(ledger, kind) !== undefined && !ledger.restored.includes(kind);
}

/** A new snapshot would capture already-modified state while an older one is unrestored. */
export function canSnapshot(ledgers: Ledger[], kind: SnapshotKind): boolean {
  return !ledgers.some((l) => hasUnrestored(l, kind));
}

/** Only this guild's ledgers: another guild's snapshots or resource IDs must never be applied here. */
export async function readLedgers(dir: string, guildId: string): Promise<Ledger[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter((n) => /^ledger-.+\.json$/.test(n)).sort();
  const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf8')) as Ledger));
  return all.filter((l) => l.guildId === guildId);
}

export async function openLedger(dir: string, runId: string): Promise<LedgerHandle | undefined> {
  const path = join(dir, `ledger-${runId}.json`);
  try {
    return { path, data: JSON.parse(await readFile(path, 'utf8')) as Ledger };
  } catch {
    return undefined;
  }
}
