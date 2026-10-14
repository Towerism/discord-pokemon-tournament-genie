import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_INVITE_PERMISSIONS, checkGenieRole, checkRoleOrder, INVITE_PERMISSIONS } from '../../src/s3/preflight.js';
import { BASE_PERMISSIONS } from '../../src/s3/profiles.js';
import { LOCK_DENIES } from '../../src/s3/types.js';

describe('checkGenieRole', () => {
  it('passes the exact candidate invite set', () => {
    expect(checkGenieRole([...INVITE_PERMISSIONS], false)).toEqual({ ok: true });
  });

  it('refuses a missing Manage Threads and names it', () => {
    const r = checkGenieRole(INVITE_PERMISSIONS.filter((p) => p !== 'ManageThreads'), false);
    expect(r).toEqual({ ok: false, reason: 'genie_permissions_mismatch', missing: ['ManageThreads'], extra: [], administrator: false });
  });

  it('refuses an extra permission', () => {
    const r = checkGenieRole([...INVITE_PERMISSIONS, 'MentionEveryone'], false);
    expect(r).toMatchObject({ ok: false, extra: ['MentionEveryone'] });
  });

  it('refuses Administrator from any role', () => {
    expect(checkGenieRole([...INVITE_PERMISSIONS], true)).toMatchObject({ ok: false, administrator: true });
  });

  it('the candidate set is §4.1\'s nine plus the four lock permissions §4.1 lacks', () => {
    expect([...INVITE_PERMISSIONS].sort()).toEqual(
      [...ARCHITECTURE_INVITE_PERMISSIONS, 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads', 'AddReactions'].sort(),
    );
    for (const p of LOCK_DENIES) expect(INVITE_PERMISSIONS).toContain(p);
  });

  it('refuses a role still holding only §4.1\'s nine, naming the four it lacks', () => {
    const r = checkGenieRole([...ARCHITECTURE_INVITE_PERMISSIONS], false);
    expect(r).toMatchObject({ ok: false, extra: [] });
    expect(r.ok ? [] : r.missing).toEqual(['AddReactions', 'CreatePrivateThreads', 'CreatePublicThreads', 'SendMessagesInThreads']);
  });

  it('leaves genie without Mention Everyone, which the hold-it diagnostics rely on', () => {
    // The check sees only the managed role; under B-default genie also holds @everyone's base.
    expect(INVITE_PERMISSIONS).not.toContain('MentionEveryone');
    expect(BASE_PERMISSIONS.default).not.toContain('MentionEveryone');
  });
});

describe('checkRoleOrder', () => {
  const good = { arranger: 10, arrangerAdmin: true, genie: 8, spikeRoles: [3, 4], probes: [1, 2] };

  it('accepts arranger > genie > spike roles > probes', () => {
    expect(checkRoleOrder(good)).toEqual({ ok: true, problems: [] });
  });

  it.each([
    [{ arrangerAdmin: false }, 'arranger lacks Administrator'],
    [{ genie: 11 }, 'arranger must be above genie'],
    [{ spikeRoles: [9] }, 'genie must be above every spike- role'],
    [{ probes: [5] }, 'every spike- role must be above the probes'],
  ])('refuses %o', (over, problem) => {
    const r = checkRoleOrder({ ...good, ...over });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(problem);
  });
});
