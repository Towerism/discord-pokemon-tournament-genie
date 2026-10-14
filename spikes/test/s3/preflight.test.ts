import { describe, expect, it } from 'vitest';
import { checkGenieRole, checkRoleOrder, INVITE_PERMISSIONS } from '../../src/s3/preflight.js';

describe('checkGenieRole', () => {
  it('passes the exact §4.1 invite set', () => {
    expect(checkGenieRole([...INVITE_PERMISSIONS], false)).toEqual({ ok: true });
  });

  it('refuses a missing Manage Threads and names it', () => {
    const r = checkGenieRole(INVITE_PERMISSIONS.filter((p) => p !== 'ManageThreads'), false);
    expect(r).toEqual({ ok: false, reason: 'genie_permissions_mismatch', missing: ['ManageThreads'], extra: [], administrator: false });
  });

  it('refuses an extra permission', () => {
    const r = checkGenieRole([...INVITE_PERMISSIONS, 'AddReactions'], false);
    expect(r).toMatchObject({ ok: false, extra: ['AddReactions'] });
  });

  it('refuses Administrator from any role', () => {
    expect(checkGenieRole([...INVITE_PERMISSIONS], true)).toMatchObject({ ok: false, administrator: true });
  });

  it('ignores the @everyone base, which is not passed in', () => {
    // The caller passes only the managed role's permissions; B-default's extras never reach this check.
    expect(INVITE_PERMISSIONS).not.toContain('AddReactions');
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
