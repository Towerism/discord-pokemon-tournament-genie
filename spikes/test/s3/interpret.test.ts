import { describe, expect, it } from 'vitest';
import { interpret } from '../../src/s3/interpret.js';
import type { Action, Observation, Outcome } from '../../src/s3/types.js';

const seeded = '1300000000000000500';
const http = (status: number, code?: number, body?: unknown): Outcome => ({ kind: 'http', status, code, body });

describe('interpret', () => {
  it.each<[string, Action, Outcome, Observation]>([
    ['200 view', 'view', http(200), 'allowed'],
    ['200 read with the seeded message', 'readHistory', http(200, undefined, [{ id: seeded }]), 'allowed'],
    ['200 read with [] (no Read Message History)', 'readHistory', http(200, undefined, []), 'denied'],
    ['200 read without the seeded message', 'readHistory', http(200, undefined, [{ id: '1300000000000000999' }]), 'inconclusive'],
    ['200 read with a non-array body', 'readHistory', http(200, undefined, { oops: true }), 'inconclusive'],
    ['204 reaction', 'reactNew', http(204), 'allowed'],
    ['201 thread created', 'createPublicThread', http(201), 'allowed'],
    ['403/50001 Missing Access', 'view', http(403, 50001), 'denied'],
    ['403/50013 Missing Permissions', 'send', http(403, 50013), 'denied'],
    ['404/10003 on view', 'view', http(404, 10003), 'denied'],
    ['404/10003 on send', 'send', http(404, 10003), 'inconclusive'],
    ['400/50083 archived thread', 'reactNew', http(400, 50083), 'blocked_archived'],
    ['429 after retries', 'send', http(429), 'inconclusive'],
    ['500', 'view', http(500), 'inconclusive'],
    ['network error', 'view', { kind: 'network', message: 'ECONNRESET' }, 'inconclusive'],
    ['403 with an unknown code', 'send', http(403, 40001), 'inconclusive'],
    ['403 without a code', 'send', http(403), 'inconclusive'],
  ])('%s', (_name, action, outcome, expected) => {
    expect(interpret(action, outcome, seeded)).toBe(expected);
  });
});
