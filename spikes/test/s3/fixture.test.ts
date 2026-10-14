import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildCatalog } from '../../src/s3/catalog.js';
import { buildFixture, changedCases, fixtureJsonSchema, FixtureSchema, serializeFixture } from '../../src/s3/fixture.js';
import { runPass } from '../../src/s3/runner.js';
import { ctx, fakePorts } from './fakes.js';

async function recorded(passIds: [string, string], recordedAt: string) {
  const catalog = buildCatalog();
  const p = await runPass(catalog, fakePorts().ports, ctx, passIds[0]);
  return buildFixture(catalog, p, {
    recordedAt,
    discordJs: '14.27.0',
    apiVersion: '10',
    passIds,
    genieRolePermissions: ctx.genieRolePermissions,
  });
}

describe('fixture', () => {
  it('is byte-identical across recordings except recordedAt and passIds, and both validate', async () => {
    const a = serializeFixture(await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z'));
    const b = serializeFixture(await recorded(['20261014090000-1234', '20261014091000-5678'], '2026-10-14T09:20:00.000Z'));
    const strip = (s: string) =>
      s.replace(/"recordedAt": "[^"]+"/, '').replace(/"passIds": \[[^\]]*\]/, '');
    expect(strip(a)).toBe(strip(b));
    expect(a).not.toBe(b);
    expect(FixtureSchema.safeParse(JSON.parse(a)).success).toBe(true);
    expect(changedCases(a, JSON.parse(b))).toEqual([]);
  });

  it('holds no snowflakes in its cases', async () => {
    const text = serializeFixture(await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z'));
    expect(JSON.stringify(JSON.parse(text).cases)).not.toMatch(/\b\d{17,20}\b/);
  });

  it('keeps cases in catalog order and sorts object keys', async () => {
    const f = await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z');
    expect(f.cases.map((c) => c.id)).toEqual(buildCatalog().map((c) => c.id));
    const text = serializeFixture(f);
    expect(text.indexOf('"cases"')).toBeLessThan(text.indexOf('"meta"'));
    expect(text.endsWith('\n')).toBe(true);
  });

  it('carries the write context, the attempt and what Discord stored', async () => {
    const f = await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z');
    const w = f.cases.find((c) => c.id === 'W2-nosend-lock');
    expect(w).toMatchObject({
      kind: 'write',
      path: 'edit',
      context: { everyone: ['ReadMessageHistory', 'ViewChannel'], genieRole: ctx.genieRolePermissions },
      result: 'ok',
    });
    if (w?.kind !== 'write') throw new Error('expected a write case');
    expect(w.context.overwritesBefore.length).toBeGreaterThan(0);
    expect(w.stored).toBeDefined();
  });

  it('records each effective case with its guild, members, thread and both views of permissions', async () => {
    const f = await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z');
    const c = f.cases.find((x) => x.id === 'R12-default-locked-staffer-public-archived');
    if (c?.kind !== 'effective') throw new Error('expected an effective case');
    expect(c.thread).toEqual({ type: 'public', archived: true, subjectIsMember: true });
    expect(c.subject).toEqual({ key: 'member:subject', roles: [] });
    expect(c.other.key).toBe('member:other');
    expect(c.guild.roles.map((r) => r.key)).toContain('role:organizer');
    expect(Object.keys(c.effective).sort()).toEqual(Object.keys(c.computedByLibrary).sort());
  });

  it('refuses to build from a pass with a case that is not ok', async () => {
    const catalog = buildCatalog();
    const p = await runPass(catalog, fakePorts({ refuseWrite: 2 }).ports, ctx, 'x');
    expect(() =>
      buildFixture(catalog, p, { recordedAt: 'x', discordJs: '14.27.0', apiVersion: '10', passIds: ['a', 'b'], genieRolePermissions: [] }),
    ).toThrow(/not conclusive/);
  });

  it('detects changed cases by id against an existing file', async () => {
    const a = await recorded(['20261013120000-0a1f', '20261013121000-0b2e'], '2026-10-13T12:20:00.000Z');
    const b = structuredClone(a);
    const target = b.cases.find((c) => c.id === 'R1-default-open-outsider');
    if (target?.kind !== 'effective') throw new Error('expected an effective case');
    target.observed.view = { result: 'denied', status: 403, code: 50001 };
    expect(changedCases(serializeFixture(a), b)).toEqual(['R1-default-open-outsider']);
  });

  it('refuses to build from a pass that stopped', () => {
    const catalog = buildCatalog();
    const stopped = { passId: 'p', writes: [], cases: [], amendmentRequired: [], stop: { reason: 'profile_unwritable' as const, caseIds: ['W1-default-sync'] } };
    expect(() =>
      buildFixture(catalog, stopped, { recordedAt: 'x', discordJs: '14.27.0', apiVersion: '10', passIds: ['a', 'b'], genieRolePermissions: [] }),
    ).toThrow(/stopped/);
  });

  it('treats a missing existing file as no change', () => {
    expect(changedCases(undefined, { schemaVersion: 1, meta: {} as never, cases: [] })).toEqual([]);
  });

  it('generates a JSON Schema from the zod schema', () => {
    const schema = JSON.parse(fixtureJsonSchema());
    expect(schema).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(FixtureSchema))));
  });
});
