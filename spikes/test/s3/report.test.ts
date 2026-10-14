import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../../src/s3/catalog.js';
import { libraryDisagreements } from '../../src/s3/report.js';
import { caseResult } from './factories.js';

const catalog = buildCatalog();

describe('libraryDisagreements', () => {
  it('lists a permission where the library and the derived effective value disagree', () => {
    const r = caseResult({
      computedByLibrary: { ...caseResult().computedByLibrary, AddReactions: true },
    });
    expect(libraryDisagreements([r], catalog)).toContainEqual({ caseId: 'R4-default-locked-staffer', permission: 'AddReactions' });
  });

  it('never lists an unobservable permission', () => {
    const r = caseResult({ computedByLibrary: { ...caseResult().computedByLibrary, SendMessagesInThreads: true } });
    expect(r.effective.SendMessagesInThreads).toBe('unobservable');
    expect(libraryDisagreements([r], catalog)).toEqual([]);
  });

  it('skips private threads the subject is not a member of (membership, not a permission)', () => {
    const r = caseResult({
      caseId: 'R11-default-open-staffer-private-notadded',
      computedByLibrary: { ...caseResult().computedByLibrary, ViewChannel: true },
      effective: { ...caseResult().effective, ViewChannel: false },
    });
    expect(libraryDisagreements([r], catalog)).toEqual([]);
  });

  it('lists nothing when they agree', () => {
    expect(libraryDisagreements([caseResult()], catalog)).toEqual([]);
  });
});
