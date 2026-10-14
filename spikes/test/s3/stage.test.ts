import { describe, expect, it } from 'vitest';
import { findCase } from '../../src/s3/catalog.js';
import { stageEligibility, stagePlan } from '../../src/s3/stage.js';

describe('stagePlan', () => {
  it('stages exactly the recorder\'s case with the alt account as the subject, kept and unrestored', () => {
    const plan = stagePlan('R4-nosend-locked-staffer', '1300000000000000777');
    expect(plan.caseDef).toEqual(findCase('R4-nosend-locked-staffer'));
    expect(plan.subjectUserId).toBe('1300000000000000777');
    expect(plan.kept).toBe(true);
    expect(plan.restoreAtEnd).toBe(false);
  });

  it('lists the actions to try in the recorder\'s order', () => {
    expect(stagePlan('R2-default-open-staffer', '1').actions.at(-1)).toBe('send');
  });

  it('refuses an unknown case', () => {
    expect(() => stagePlan('R99-default-open-staffer', '1')).toThrow(/unknown case/);
  });

  it('refuses a write case (nothing to try by hand)', () => {
    expect(() => stagePlan('W1-default-mroverwrite', '1')).toThrow(/effective/);
  });
});

describe('stageEligibility', () => {
  it.each([
    [{ isOwner: true, hasAdministrator: false, isBot: false }, 'subject_is_owner'],
    [{ isOwner: false, hasAdministrator: true, isBot: false }, 'subject_is_administrator'],
    [{ isOwner: false, hasAdministrator: false, isBot: true }, 'subject_is_bot'],
  ] as const)('refuses %o', (subject, reason) => {
    expect(stageEligibility(subject)).toEqual({ ok: false, reason });
  });

  it('accepts an ordinary member', () => {
    expect(stageEligibility({ isOwner: false, hasAdministrator: false, isBot: false })).toEqual({ ok: true });
  });
});
