import { deriveEffective } from './effective.js';
import { interpret } from './interpret.js';
import type { ResolvedOverwrite, RunContext, RunnerPorts } from './ports.js';
import { BASE_PERMISSIONS, categoryProfile } from './profiles.js';
import { resolve, sameOverwrites, sortOverwrites, unresolve, type Ids } from './resolve.js';
import type {
  Action,
  Case,
  CaseResult,
  EffectiveCase,
  Observation,
  ObservationRecord,
  Outcome,
  Overwrite,
  PassResult,
  PermissionName,
  WriteCase,
  WriteCaseRecord,
} from './types.js';

export const MAX_ATTEMPTS = 3;
/** The reaction the arranger adds to the seeded message; `reactNew` uses a different emoji. */
export const EXISTING_EMOJI = '👍';
export const NEW_EMOJI = '🎉';

const is2xx = (o: Outcome) => o.kind === 'http' && o.status >= 200 && o.status < 300;
const describe = (o: Outcome) => (o.kind === 'http' ? `${o.status}${o.code ? `/${o.code}` : ''}` : `network: ${o.message}`);

function idsFor(ctx: RunContext, roles: Record<string, string>): Ids {
  return {
    guildId: ctx.guildId,
    roles,
    members: { 'member:subject': ctx.members.subject, 'member:other': ctx.members.other, 'member:genie': ctx.members.genie },
  };
}

const caseName = (ctx: RunContext, c: Case) => `spike-${ctx.runId}-${c.id.toLowerCase()}`;

async function arrangeMembers(c: Case, ports: RunnerPorts, ctx: RunContext): Promise<Ids> {
  await ports.arrange.setEveryoneBase(BASE_PERMISSIONS[c.base]);
  const roles = await ports.arrange.ensureRoles(c.roles);
  const roleIds = (keys: string[]) => keys.map((k) => roles[k]!).filter(Boolean);
  if (c.kind === 'effective') await ports.arrange.ensureMemberRoles(ctx.members.subject, roleIds(c.subjectRoles));
  await ports.arrange.ensureMemberRoles(ctx.members.other, roleIds(c.otherRoles));
  return idsFor(ctx, roles);
}

function emptyResult(c: EffectiveCase): CaseResult {
  return {
    caseId: c.id,
    status: 'ok',
    categoryOverwrites: c.category ? sortOverwrites(c.category.overwrites) : null,
    channelOverwrites: [],
    observed: {},
    effective: deriveEffective({}, c.thread ? 'thread' : 'channel'),
    computedByLibrary: {} as Record<PermissionName, boolean>,
  };
}

export type Prepared =
  | { ok: true; result: CaseResult; targetId: string; threadId?: string; seededMessageId: string }
  | { ok: false; result: CaseResult };

/** Arrange and write (FR-18 steps 1–3). `s3 stage` stops here; the recorder goes on to observe. */
export async function prepareCase(c: EffectiveCase, ports: RunnerPorts, ctx: RunContext): Promise<Prepared> {
  const result = emptyResult(c);
  const ids = await arrangeMembers(c, ports, ctx);

  const { channelId } = await ports.arrange.createTarget({
    name: caseName(ctx, c),
    category: c.category ? resolve(c.category.overwrites, ids) : null,
    rawUnderCategory: c.createdUnderCategoryWithoutOverwrites,
    channelOverwrites: [],
  });

  let threadId: string | undefined;
  if (c.thread) {
    const members = [ctx.members.other, ...(c.thread === 'private-notadded' ? [] : [ctx.members.subject])];
    threadId = await ports.arrange.createThread(channelId, c.thread, members);
  }

  let lastWritten: Overwrite[] | null = null;
  for (const [i, write] of (c.genieWrites ?? []).entries()) {
    const outcome = await ports.write.writeOverwrites(channelId, resolve(write, ids));
    if (!is2xx(outcome)) {
      return { ok: false, result: { ...result, status: 'arrange_failed', failure: `genie write ${i + 1} refused (${describe(outcome)})` } };
    }
    lastWritten = write;
  }
  const stored = unresolve(await ports.write.readOverwrites(channelId), ids);
  result.channelOverwrites = sortOverwrites(stored);
  if (lastWritten && !sameOverwrites(stored, lastWritten)) {
    return { ok: false, result: { ...result, status: 'arrange_failed', failure: 'read-back differs from the last genie write' } };
  }

  const targetId = threadId ?? channelId;
  const seededMessageId = await ports.arrange.seedMessage(targetId, EXISTING_EMOJI);
  if (threadId && c.thread === 'public-archived') await ports.arrange.archiveThread(threadId);
  return { ok: true, result, targetId, seededMessageId, ...(threadId ? { threadId } : {}) };
}

/** Arrange → write → observe for one effective-permission case (FR-18). */
export async function runCase(c: EffectiveCase, ports: RunnerPorts, ctx: RunContext): Promise<CaseResult> {
  const prepared = await prepareCase(c, ports, ctx);
  if (!prepared.ok) return prepared.result;
  const { result, targetId, threadId, seededMessageId } = prepared;
  result.computedByLibrary = await ports.write.libraryPermissions(targetId, ctx.members.subject);

  const raw: Partial<Record<Action, Observation>> = {};
  for (const action of c.actions) {
    let observation: Observation = 'inconclusive';
    let last: Outcome | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && observation === 'inconclusive'; attempt++) {
      last = await ports.act.attempt(action, targetId, seededMessageId);
      observation = interpret(action, last, seededMessageId);
    }
    if (observation === 'inconclusive') {
      return { ...result, status: 'inconclusive', failure: `${action}: ${describe(last!)} after ${MAX_ATTEMPTS} attempts` };
    }
    raw[action] = observation;
    const record: ObservationRecord = { result: observation, status: last!.kind === 'http' ? last!.status : 0 };
    if (last!.kind === 'http' && last!.code !== undefined) record.code = last!.code;
    if (threadId) record.archivedAfter = await ports.threadState.isArchived(threadId);
    result.observed[action] = record;
  }

  result.effective = deriveEffective(raw, c.thread ? 'thread' : 'channel');
  return result;
}

/** One write case: arrange its context, let genie attempt the write, read back what Discord stored (FR-21). */
export async function runWriteCase(c: WriteCase, ports: RunnerPorts, ctx: RunContext): Promise<WriteCaseRecord> {
  const ids = await arrangeMembers(c, ports, ctx);
  const name = caseName(ctx, c);
  let outcome: Outcome;
  let targetId: string | undefined;

  if (c.path === 'create') {
    const parentId =
      c.target === 'channel' ? await ports.arrange.createParentCategory(`${name}-parent`, resolve(categoryProfile(), ids)) : undefined;
    const created = await ports.write.createWithOverwrites({
      kind: c.target,
      name,
      ...(parentId ? { parentId } : {}),
      overwrites: resolve(c.attempted, ids),
    });
    outcome = created.outcome;
    targetId = created.id;
  } else {
    const { channelId } = await ports.arrange.createTarget({
      name,
      category: null,
      rawUnderCategory: false,
      channelOverwrites: resolve(c.overwritesBefore, ids),
    });
    outcome = await ports.write.writeOverwrites(channelId, resolve(c.attempted, ids));
    targetId = channelId;
  }

  if (!is2xx(outcome) || targetId === undefined) {
    const refused: WriteCaseRecord = { caseId: c.id, result: 'refused' };
    if (outcome.kind === 'http') {
      refused.status = outcome.status;
      if (outcome.code !== undefined) refused.code = outcome.code;
    }
    return refused;
  }
  const stored: ResolvedOverwrite[] = await ports.write.readOverwrites(targetId);
  return { caseId: c.id, result: 'ok', stored: sortOverwrites(unresolve(stored, ids)) };
}

export function isUnwritable(c: WriteCase, r: WriteCaseRecord): boolean {
  return r.result === 'refused' || !r.stored || !sameOverwrites(r.stored, c.attempted);
}

/** FR-22's rules: an unwritable edit path stops; a create path stops only if the fallback is unwritable too. */
export function evaluateProduction(
  cases: WriteCase[],
  records: WriteCaseRecord[],
): { stop: string[]; amendmentRequired: string[] } {
  const unwritable = new Set(
    cases.filter((c) => {
      const r = records.find((x) => x.caseId === c.id);
      return r !== undefined && isUnwritable(c, r);
    }).map((c) => c.id),
  );
  const stop: string[] = [];
  const amendmentRequired: string[] = [];
  for (const base of ['default', 'nosend'] as const) {
    const ofRole = (role: WriteCase['productionRole']) => cases.filter((c) => c.base === base && c.productionRole === role).map((c) => c.id);
    const failing = (xs: string[]) => xs.filter((id) => unwritable.has(id));
    const edit = failing(ofRole('edit'));
    const create = failing(ofRole('create'));
    const fallback = failing(ofRole('fallback'));
    stop.push(...edit);
    if (create.length > 0 && fallback.length > 0) stop.push(...create, ...fallback);
    else amendmentRequired.push(...create);
  }
  return { stop, amendmentRequired };
}

/** One pass over the catalog on fresh resources: write cases first, then the effective cases. */
export async function runPass(catalog: Case[], ports: RunnerPorts, ctx: RunContext, passId: string): Promise<PassResult> {
  const writeCases = catalog.filter((c): c is WriteCase => c.kind === 'write');
  const effectiveCases = catalog.filter((c): c is EffectiveCase => c.kind === 'effective');
  const writes: WriteCaseRecord[] = [];
  for (const c of writeCases) {
    try {
      writes.push(await runWriteCase(c, ports, ctx));
    } finally {
      await ports.arrange.teardownCase();
    }
  }
  const { stop, amendmentRequired } = evaluateProduction(writeCases, writes);
  if (stop.length > 0) {
    return { passId, writes, cases: [], stop: { reason: 'profile_unwritable', caseIds: stop.sort() }, amendmentRequired };
  }
  const cases: CaseResult[] = [];
  for (const c of effectiveCases) {
    try {
      cases.push(await runCase(c, ports, ctx));
    } finally {
      await ports.arrange.teardownCase();
    }
  }
  return { passId, writes, cases, amendmentRequired };
}
