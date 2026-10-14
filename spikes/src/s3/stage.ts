import { findCase } from './catalog.js';
import type { Action, EffectiveCase } from './types.js';

export type StagePlan = {
  caseDef: EffectiveCase;
  subjectUserId: string;
  actions: readonly Action[];
  /** A staged case stays up, with its base, until `cleanup --run`. */
  kept: true;
  restoreAtEnd: false;
};

/** The same arrange-and-write plan the recorder uses, with the alt account as `member:subject`. */
export function stagePlan(caseId: string, subjectUserId: string): StagePlan {
  const c = findCase(caseId);
  if (!c) throw new Error(`unknown case ${caseId}`);
  if (c.kind !== 'effective') throw new Error(`${caseId} is a write case; only effective cases can be staged`);
  return { caseDef: c, subjectUserId, actions: c.actions, kept: true, restoreAtEnd: false };
}

export type StageSubject = { isOwner: boolean; hasAdministrator: boolean; isBot: boolean };

/** The owner and Administrators bypass overwrites, and the bots are the recorder's own identities. */
export function stageEligibility(
  s: StageSubject,
): { ok: true } | { ok: false; reason: 'subject_is_owner' | 'subject_is_administrator' | 'subject_is_bot' } {
  if (s.isOwner) return { ok: false, reason: 'subject_is_owner' };
  if (s.hasAdministrator) return { ok: false, reason: 'subject_is_administrator' };
  if (s.isBot) return { ok: false, reason: 'subject_is_bot' };
  return { ok: true };
}
