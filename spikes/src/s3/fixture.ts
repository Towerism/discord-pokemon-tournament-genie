import { z } from 'zod';
import { BASE_PERMISSIONS } from './profiles.js';
import { CHANNEL_ACTIONS, PERMISSIONS, type Case, type PassResult } from './types.js';

const Permission = z.enum(PERMISSIONS);
const Action = z.enum(CHANNEL_ACTIONS);

const Overwrite = z.object({
  target: z.string().regex(/^(everyone|role:[a-z]+|member:(subject|other|genie|unknown))$/),
  allow: z.array(Permission),
  deny: z.array(Permission),
  allowOther: z.array(z.string()),
  denyOther: z.array(z.string()),
});

const Observed = z.object({
  result: z.enum(['allowed', 'denied', 'blocked_archived']),
  status: z.number().int(),
  code: z.number().int().optional(),
  archivedAfter: z.boolean().optional(),
});

const Member = z.object({ key: z.enum(['member:subject', 'member:other']), roles: z.array(z.string()) });

const EffectiveRecord = z.object({
  id: z.string(),
  kind: z.literal('effective'),
  guild: z.object({
    everyone: z.array(Permission),
    roles: z.array(
      z.object({
        key: z.string(),
        position: z.number().int(),
        aboveGenie: z.boolean().optional(),
        permissions: z.array(z.string()),
      }),
    ),
  }),
  subject: Member,
  other: Member,
  category: z.object({ overwrites: z.array(Overwrite) }).nullable(),
  channel: z.object({ createdUnderCategoryWithoutOverwrites: z.boolean(), overwrites: z.array(Overwrite) }),
  thread: z
    .object({ type: z.enum(['public', 'private']), archived: z.boolean(), subjectIsMember: z.boolean() })
    .nullable(),
  observed: z.partialRecord(Action, Observed),
  /** The oracle M2's fake is checked against. */
  effective: z.record(Permission, z.union([z.boolean(), z.literal('unobservable')])),
  /** discord.js's computed view; informational only. */
  computedByLibrary: z.record(Permission, z.boolean()),
});

const WriteRecord = z.object({
  id: z.string(),
  kind: z.literal('write'),
  path: z.enum(['create', 'edit']),
  context: z.object({
    everyone: z.array(Permission),
    genieRole: z.array(z.string()),
    overwritesBefore: z.array(Overwrite),
  }),
  attempted: z.array(Overwrite),
  result: z.enum(['ok', 'refused']),
  code: z.number().int().optional(),
  stored: z.array(Overwrite).optional(),
});

export const FixtureSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    recordedAt: z.string(),
    discordJs: z.string(),
    apiVersion: z.string(),
    passIds: z.tuple([z.string(), z.string()]),
  }),
  cases: z.array(z.discriminatedUnion('kind', [EffectiveRecord, WriteRecord])),
});

export type Fixture = z.infer<typeof FixtureSchema>;
type FixtureCase = Fixture['cases'][number];

export type FixtureMeta = Fixture['meta'] & { genieRolePermissions: string[] };

/** Builds the fixture from a stable pass. Every case must be conclusive. */
export function buildFixture(catalog: Case[], pass: PassResult, meta: FixtureMeta): Fixture {
  if (pass.stop) throw new Error(`pass ${pass.passId} stopped: ${pass.stop.caseIds.join(', ')}`);
  const cases: FixtureCase[] = catalog.map((c): FixtureCase => {
    if (c.kind === 'write') {
      const r = pass.writes.find((w) => w.caseId === c.id);
      if (!r) throw new Error(`case ${c.id} is not conclusive: no record`);
      return {
        id: c.id,
        kind: 'write',
        path: c.path,
        context: { everyone: BASE_PERMISSIONS[c.base], genieRole: [...meta.genieRolePermissions].sort(), overwritesBefore: c.overwritesBefore },
        attempted: c.attempted,
        result: r.result,
        ...(r.code !== undefined ? { code: r.code } : {}),
        ...(r.stored ? { stored: r.stored } : {}),
      };
    }
    const r = pass.cases.find((x) => x.caseId === c.id);
    if (!r || r.status !== 'ok') throw new Error(`case ${c.id} is not conclusive: ${r?.status ?? 'no record'}`);
    return {
      id: c.id,
      kind: 'effective',
      guild: { everyone: BASE_PERMISSIONS[c.base], roles: c.roles },
      subject: { key: 'member:subject', roles: c.subjectRoles },
      other: { key: 'member:other', roles: c.otherRoles },
      category: r.categoryOverwrites ? { overwrites: r.categoryOverwrites } : null,
      channel: { createdUnderCategoryWithoutOverwrites: c.createdUnderCategoryWithoutOverwrites, overwrites: r.channelOverwrites },
      thread: c.thread
        ? {
            type: c.thread.startsWith('private') ? 'private' : 'public',
            archived: c.thread === 'public-archived',
            subjectIsMember: c.thread !== 'private-notadded',
          }
        : null,
      observed: r.observed,
      effective: r.effective,
      computedByLibrary: r.computedByLibrary,
    };
  });
  const { genieRolePermissions: _g, ...fixtureMeta } = meta;
  return { schemaVersion: 1, meta: fixtureMeta, cases };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** Deterministic: sorted keys, catalog order, two-space indent, trailing newline (NFR-2). */
export function serializeFixture(f: Fixture): string {
  return `${JSON.stringify(sortKeys(FixtureSchema.parse(f)), null, 2)}\n`;
}

export function fixtureJsonSchema(): string {
  return `${JSON.stringify(sortKeys(z.toJSONSchema(FixtureSchema)), null, 2)}\n`;
}

/** Case IDs whose recorded content differs; meta (recordedAt, passIds) is ignored (EC-14). */
export function changedCases(existingText: string | undefined, next: Fixture): string[] {
  if (existingText === undefined) return [];
  const old = JSON.parse(existingText) as Fixture;
  const key = (c: FixtureCase) => JSON.stringify(sortKeys(c));
  const before = new Map(old.cases.map((c) => [c.id, key(c)]));
  const after = new Map(next.cases.map((c) => [c.id, key(c)]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  return [...ids].filter((id) => before.get(id) !== after.get(id)).sort();
}
