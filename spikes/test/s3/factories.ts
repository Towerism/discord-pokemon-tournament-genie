import { deriveEffective } from '../../src/s3/effective.js';
import { PERMISSIONS, type CaseResult, type PassResult, type PermissionName, type WriteCaseRecord } from '../../src/s3/types.js';

export function caseResult(over: Partial<CaseResult> = {}): CaseResult {
  const observed: CaseResult['observed'] = {
    view: { result: 'allowed', status: 200 },
    readHistory: { result: 'allowed', status: 200 },
    reactExisting: { result: 'allowed', status: 204 },
    reactNew: { result: 'denied', status: 403, code: 50013 },
    createPublicThread: { result: 'denied', status: 403, code: 50013 },
    createPrivateThread: { result: 'denied', status: 403, code: 50013 },
    send: { result: 'denied', status: 403, code: 50013 },
  };
  const effective = deriveEffective(
    Object.fromEntries(Object.entries(observed).map(([k, v]) => [k, v!.result])),
    'channel',
  );
  return {
    caseId: 'R4-default-locked-staffer',
    status: 'ok',
    categoryOverwrites: null,
    channelOverwrites: [],
    observed,
    effective,
    // By default the library agrees with every observable permission.
    computedByLibrary: Object.fromEntries(PERMISSIONS.map((p) => [p, effective[p] === true])) as Record<PermissionName, boolean>,
    ...over,
  };
}

export function writeRecord(over: Partial<WriteCaseRecord> = {}): WriteCaseRecord {
  return { caseId: 'W1-default-mroverwrite', result: 'ok', stored: [], ...over };
}

export function pass(over: Partial<PassResult> = {}): PassResult {
  return { passId: '20261013120000-0a1f', writes: [writeRecord()], cases: [caseResult()], amendmentRequired: [], ...over };
}
