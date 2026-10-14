import { describe, expect, it } from 'vitest';
import { buildCatalog, findCase } from '../../src/s3/catalog.js';
import { runCase, runPass, runWriteCase } from '../../src/s3/runner.js';
import type { EffectiveCase, WriteCase } from '../../src/s3/types.js';
import { archivedBlock, ctx, denied, fakePorts, flaky, ok } from './fakes.js';

const eff = (id: string) => findCase(id) as EffectiveCase;
const wc = (id: string) => findCase(id) as WriteCase;

describe('runCase', () => {
  it('records the interpreted outcome of every action and derives effective permissions', async () => {
    const { ports } = fakePorts({ act: { send: [denied], reactNew: [denied] } });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.observed.view).toEqual({ result: 'allowed', status: 200 });
    expect(r.observed.send).toEqual({ result: 'denied', status: 403, code: 50013 });
    expect(r.effective.SendMessages).toBe(false);
    expect(r.effective.AddReactions).toBe(false);
    expect(r.effective.ViewChannel).toBe(true);
  });

  it('attempts actions in the fixed order with send last', async () => {
    const { ports, attempts } = fakePorts();
    await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(attempts).toEqual(['view', 'readHistory', 'reactExisting', 'reactNew', 'createPublicThread', 'createPrivateThread', 'send']);
  });

  it('retries an inconclusive action and keeps the first conclusive answer', async () => {
    const { ports, attempts } = fakePorts({ act: { view: [flaky, flaky, ok()] } });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.observed.view?.result).toBe('allowed');
    expect(attempts.filter((a) => a === 'view')).toHaveLength(3);
  });

  it('marks the case inconclusive only after three inconclusive attempts', async () => {
    const { ports, attempts } = fakePorts({ act: { view: [flaky] } });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('inconclusive');
    expect(r.failure).toMatch(/view/);
    expect(attempts.filter((a) => a === 'view')).toHaveLength(3);
  });

  it('archived thread: actions before send see it archived; reactions blocked are conclusive; send unarchives it', async () => {
    const { ports, attempts } = fakePorts({ act: { reactExisting: [archivedBlock], reactNew: [archivedBlock], send: [ok()] } });
    const r = await runCase(eff('R12-default-locked-admin-public-archived'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(attempts).toEqual(['view', 'readHistory', 'reactExisting', 'reactNew', 'send']);
    expect(r.observed.view?.archivedAfter).toBe(true);
    expect(r.observed.reactExisting).toMatchObject({ result: 'blocked_archived', archivedAfter: true });
    expect(r.observed.reactNew).toMatchObject({ result: 'blocked_archived', archivedAfter: true });
    expect(r.observed.send).toMatchObject({ result: 'allowed', archivedAfter: false });
    expect(r.effective.AddReactions).toBe('unobservable');
  });

  it('a locked staffer\'s denied send leaves the archived thread archived', async () => {
    const { ports } = fakePorts({ act: { reactExisting: [archivedBlock], reactNew: [archivedBlock], send: [denied] } });
    const r = await runCase(eff('R12-default-locked-staffer-public-archived'), ports, ctx);
    expect(r.observed.send).toMatchObject({ result: 'denied', archivedAfter: true });
  });

  it('channel cases carry no archivedAfter', async () => {
    const { ports } = fakePorts();
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.observed.send).not.toHaveProperty('archivedAfter');
  });

  it('is arrange_failed when the locked write is refused, and observes nothing', async () => {
    const { ports, attempts } = fakePorts({ refuseWrite: 2 });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.status).toBe('arrange_failed');
    expect(r.failure).toMatch(/write 2/);
    expect(attempts).toEqual([]);
  });

  it('is arrange_failed when Discord stores something other than what genie wrote', async () => {
    const { ports } = fakePorts({ storeDifferently: (w) => w.map((o) => ({ ...o, allow: o.allow.filter((p) => p !== 'ManageRoles') })) });
    const r = await runCase(eff('R2-default-open-staffer'), ports, ctx);
    expect(r.status).toBe('arrange_failed');
    expect(r.failure).toMatch(/read-back/);
  });

  it('R8: genie writes nothing and the channel\'s overwrites are read back after the create', async () => {
    const { ports, overwrites } = fakePorts({ refuseWrite: 1 });
    const r = await runCase(eff('R8-default-category-staffer'), ports, ctx);
    expect(r.status).toBe('ok');
    expect(r.channelOverwrites.find((o) => o.target === 'everyone')?.deny).toEqual(['ViewChannel']);
    expect(r.categoryOverwrites).not.toBeNull();
    expect([...overwrites.values()].length).toBeGreaterThan(0);
  });

  it('records the library view beside the observation without using it', async () => {
    const { ports } = fakePorts({ library: { SendMessages: true }, act: { send: [denied] } });
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(r.computedByLibrary.SendMessages).toBe(true);
    expect(r.effective.SendMessages).toBe(false);
  });

  it('stores channel overwrites symbolically, with no snowflakes', async () => {
    const { ports } = fakePorts();
    const r = await runCase(eff('R4-default-locked-staffer'), ports, ctx);
    expect(JSON.stringify(r)).not.toMatch(/\b\d{17,20}\b/);
  });
});

describe('runWriteCase', () => {
  it('records a refusal with its code and context', async () => {
    const { ports } = fakePorts({ refuseEditFor: () => true });
    const r = await runWriteCase(wc('W2-nosend-nomroverwrite'), ports, ctx);
    expect(r).toMatchObject({ caseId: 'W2-nosend-nomroverwrite', result: 'refused', status: 403, code: 50013 });
    expect(r.stored).toBeUndefined();
  });

  it('records what Discord stored, not what was attempted', async () => {
    const { ports } = fakePorts({ storeDifferently: (w) => w.slice(1) });
    const r = await runWriteCase(wc('W1-default-mroverwrite'), ports, ctx);
    expect(r.result).toBe('ok');
    expect(r.stored).toHaveLength(wc('W1-default-mroverwrite').attempted.length - 1);
  });

  it('creates through the create path', async () => {
    const { ports } = fakePorts({ createOutcome: (k) => (k === 'channel' ? { kind: 'http', status: 403, code: 50013 } : ok(201)) });
    expect((await runWriteCase(wc('W0-default-createcategory'), ports, ctx)).result).toBe('ok');
    expect((await runWriteCase(wc('W0-default-create'), ports, ctx)).result).toBe('refused');
  });
});

describe('runPass', () => {
  const catalog = buildCatalog();

  it('runs every case and tears each one down', async () => {
    const f = fakePorts();
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.writes).toHaveLength(16);
    expect(pass.cases).toHaveLength(catalog.length - 16);
    expect(f.teardowns()).toBe(catalog.length);
  });

  it('stops before the effective cases when an edit-path production case is refused', async () => {
    const f = fakePorts({ refuseEditFor: (name) => name.includes('w1-default-mroverwrite') });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toEqual({ reason: 'profile_unwritable', caseIds: ['W1-default-mroverwrite'] });
    expect(pass.cases).toEqual([]);
  });

  it('stops when an accepted production write is stored differently', async () => {
    const f = fakePorts({
      storeDifferently: (w) => w.map((o) => ({ ...o, allow: o.allow.filter((p) => p !== 'ManageRoles') })),
    });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop?.reason).toBe('profile_unwritable');
  });

  it('continues when only the create path is refused and the fallback works, flagging the amendment', async () => {
    const f = fakePorts({ createOutcome: () => ({ kind: 'http', status: 403, code: 50013 }) });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.amendmentRequired.sort()).toEqual(
      ['W0-default-create', 'W0-default-createcategory', 'W0-nosend-create', 'W0-nosend-createcategory'].sort(),
    );
    expect(pass.cases.length).toBeGreaterThan(0);
  });

  it('stops when the create path and the fallback are both unwritable', async () => {
    const f = fakePorts({
      createOutcome: () => ({ kind: 'http', status: 403, code: 50013 }),
      refuseEditFor: (name) => name.includes('w1-nosend-nomroverwrite'),
    });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop?.caseIds.sort()).toEqual(['W0-nosend-create', 'W0-nosend-createcategory', 'W1-nosend-nomroverwrite'].sort());
  });

  it('records a non-production refusal as data and carries on', async () => {
    const f = fakePorts({ refuseEditFor: (name) => name.includes('w2-nosend-nomroverwrite') });
    const pass = await runPass(catalog, f.ports, ctx, 'p1');
    expect(pass.stop).toBeUndefined();
    expect(pass.writes.find((w) => w.caseId === 'W2-nosend-nomroverwrite')?.result).toBe('refused');
  });
});
