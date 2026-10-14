import type { CaseResult, PassResult, WriteCaseRecord } from './types.js';

const observationKey = (r: CaseResult) =>
  JSON.stringify(
    Object.entries(r.observed)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([action, o]) => [action, o!.result, o!.archivedAfter ?? null]),
  );

const writeKey = (w: WriteCaseRecord) => JSON.stringify([w.result, w.code ?? null, w.stored ?? null]);

/** Two passes on fresh resources must agree on every observation and write outcome. */
export function checkStability(a: PassResult, b: PassResult): { stable: true } | { stable: false; caseIds: string[] } {
  const failing = new Set<string>();
  if (a.stop) a.stop.caseIds.forEach((id) => failing.add(id));
  if (b.stop) b.stop.caseIds.forEach((id) => failing.add(id));

  const ids = new Set([...a.cases, ...b.cases].map((c) => c.caseId));
  for (const id of ids) {
    const x = a.cases.find((c) => c.caseId === id);
    const y = b.cases.find((c) => c.caseId === id);
    if (!x || !y || x.status !== 'ok' || y.status !== 'ok' || observationKey(x) !== observationKey(y)) failing.add(id);
  }
  const writeIds = new Set([...a.writes, ...b.writes].map((w) => w.caseId));
  for (const id of writeIds) {
    const x = a.writes.find((w) => w.caseId === id);
    const y = b.writes.find((w) => w.caseId === id);
    if (!x || !y || writeKey(x) !== writeKey(y)) failing.add(id);
  }
  if (failing.size === 0 && !a.stop && !b.stop) return { stable: true };
  return { stable: false, caseIds: [...failing].sort() };
}
