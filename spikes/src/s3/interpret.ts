import type { Action, Observation, Outcome } from './types.js';

const MISSING_ACCESS = 50001;
const MISSING_PERMISSIONS = 50013;
const UNKNOWN_CHANNEL = 10003;
const ARCHIVED_THREAD = 50083;

/** Maps one attempt's HTTP outcome to what it says about the subject's ability. */
export function interpret(action: Action, outcome: Outcome, seededMessageId: string): Observation {
  if (outcome.kind === 'network') return 'inconclusive';
  const { status, code, body } = outcome;

  if (status >= 200 && status < 300) {
    if (action !== 'readHistory') return 'allowed';
    if (!Array.isArray(body)) return 'inconclusive';
    if (body.length === 0) return 'denied'; // Discord returns [] without Read Message History
    return body.some((m) => (m as { id?: unknown }).id === seededMessageId) ? 'allowed' : 'inconclusive';
  }
  if (status === 403 && (code === MISSING_ACCESS || code === MISSING_PERMISSIONS)) return 'denied';
  if (status === 404 && code === UNKNOWN_CHANNEL && action === 'view') return 'denied';
  if (status === 400 && code === ARCHIVED_THREAD) return 'blocked_archived';
  return 'inconclusive';
}
