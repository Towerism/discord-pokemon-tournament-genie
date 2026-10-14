import { describe, expect, it } from 'vitest';
import { checkStability } from '../../src/s3/stability.js';
import { caseResult, pass, writeRecord } from './factories.js';

describe('checkStability', () => {
  it('accepts two identical, fully conclusive passes', () => {
    expect(checkStability(pass(), pass({ passId: '20261013130000-beef' }))).toEqual({ stable: true });
  });

  it('reports a case whose observation differs between passes', () => {
    const b = pass({
      cases: [caseResult({ observed: { ...caseResult().observed, send: { result: 'allowed', status: 200 } } })],
    });
    expect(checkStability(pass(), b)).toEqual({ stable: false, caseIds: ['R4-default-locked-staffer'] });
  });

  it('reports a thread whose archived state after an action differs', () => {
    const a = pass({ cases: [caseResult({ observed: { send: { result: 'denied', status: 403, code: 50013, archivedAfter: true } } })] });
    const b = pass({ cases: [caseResult({ observed: { send: { result: 'denied', status: 403, code: 50013, archivedAfter: false } } })] });
    expect(checkStability(a, b).stable).toBe(false);
  });

  it('ignores status-code noise when the result agrees', () => {
    const b = pass({ cases: [caseResult({ observed: { ...caseResult().observed, view: { result: 'allowed', status: 204 } } })] });
    expect(checkStability(pass(), b)).toEqual({ stable: true });
  });

  it('reports any case that is not ok in either pass', () => {
    expect(checkStability(pass({ cases: [caseResult({ status: 'arrange_failed' })] }), pass())).toEqual({
      stable: false,
      caseIds: ['R4-default-locked-staffer'],
    });
    expect(checkStability(pass(), pass({ cases: [caseResult({ status: 'inconclusive' })] })).stable).toBe(false);
  });

  it('reports a write case whose outcome differs', () => {
    expect(checkStability(pass(), pass({ writes: [writeRecord({ result: 'refused', code: 50013 })] }))).toEqual({
      stable: false,
      caseIds: ['W1-default-sync'],
    });
  });

  it('reports a case missing from one pass', () => {
    expect(checkStability(pass(), pass({ cases: [] }))).toEqual({ stable: false, caseIds: ['R4-default-locked-staffer'] });
  });

  it('is unstable when either pass stopped', () => {
    const stopped = pass({ cases: [], stop: { reason: 'profile_unwritable', caseIds: ['W1-default-sync'] } });
    expect(checkStability(stopped, pass()).stable).toBe(false);
  });
});
