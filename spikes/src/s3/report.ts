import { PERMISSIONS, type Case, type CaseResult, type PermissionName } from './types.js';

/**
 * Where discord.js's computed permissions disagree with what was observed. Private threads the
 * subject isn't in are skipped: there `ViewChannel: false` is membership, not a permission bit.
 */
export function libraryDisagreements(results: CaseResult[], catalog: Case[]): { caseId: string; permission: PermissionName }[] {
  const out: { caseId: string; permission: PermissionName }[] = [];
  for (const r of results) {
    const c = catalog.find((x) => x.id === r.caseId);
    if (c?.kind === 'effective' && c.thread === 'private-notadded') continue;
    for (const p of PERMISSIONS) {
      const e = r.effective[p];
      if (typeof e === 'boolean' && r.computedByLibrary[p] !== undefined && r.computedByLibrary[p] !== e) {
        out.push({ caseId: r.caseId, permission: p });
      }
    }
  }
  return out;
}
