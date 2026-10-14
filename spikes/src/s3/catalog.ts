import { categoryProfile, genieOverwrite, lockedProfile, openProfile, overwrite, stafferOpen } from './profiles.js';
import {
  CHANNEL_ACTIONS,
  THREAD_ACTIONS,
  type Base,
  type Case,
  type EffectiveCase,
  type Profile,
  type RoleSpec,
  type Subject,
  type ThreadVariant,
  type WriteCase,
} from './types.js';

const ORGANIZER: RoleSpec = { key: 'role:organizer', position: 0, permissions: [] };
const ADMIN: RoleSpec = { key: 'role:admin', position: 1, permissions: ['Administrator'] };
const SENDROLE: RoleSpec = { key: 'role:sendrole', position: 1, permissions: ['SendMessages'] };
const HIGH: RoleSpec = { key: 'role:high', position: 2, aboveGenie: true, permissions: [] };

const isStaffer = (s: Subject) => s === 'staffer' || s === 'sendrole';

function subjectRoles(subject: Subject): RoleSpec[] {
  if (subject === 'organizer') return [];
  if (subject === 'admin') return [ADMIN];
  if (subject === 'sendrole') return [SENDROLE];
  return [];
}

function effectiveCase(
  row: string,
  base: Base,
  profile: Profile,
  subject: Subject,
  thread: ThreadVariant | null,
  overrides: Partial<EffectiveCase> = {},
): EffectiveCase {
  const extra = subjectRoles(subject);
  const genieWrites =
    profile === 'locked'
      ? [openProfile(isStaffer(subject)), lockedProfile(isStaffer(subject))]
      : [openProfile(isStaffer(subject))];
  return {
    kind: 'effective',
    id: [row, base, profile, subject, ...(thread ? [thread] : [])].join('-'),
    row,
    base,
    profile,
    subject,
    thread,
    roles: [ORGANIZER, ...extra],
    subjectRoles: subject === 'organizer' ? ['role:organizer'] : extra.map((r) => r.key),
    otherRoles: [],
    category: null,
    createdUnderCategoryWithoutOverwrites: false,
    genieWrites,
    actions: thread ? THREAD_ACTIONS : CHANNEL_ACTIONS,
    ...overrides,
  };
}

function expand(
  row: string,
  bases: Base[],
  profiles: Profile[],
  subjects: Subject[],
  threads: (ThreadVariant | null)[] = [null],
): EffectiveCase[] {
  return bases.flatMap((b) => profiles.flatMap((p) => subjects.flatMap((s) => threads.map((t) => effectiveCase(row, b, p, s, t)))));
}

function categoryOverwritesFor(subject: Subject) {
  return [
    overwrite('everyone', { deny: ['ViewChannel'] }),
    genieOverwrite(),
    ...(isStaffer(subject) ? [stafferOpen('member:subject')] : []),
    stafferOpen('member:other'),
  ];
}

function effectiveRows(): EffectiveCase[] {
  return [
    ...expand('R1', ['default', 'nosend'], ['open', 'locked'], ['outsider']),
    ...expand('R2', ['default', 'nosend'], ['open'], ['staffer']),
    ...expand('R3', ['default'], ['open'], ['organizer']),
    ...expand('R4', ['default', 'nosend'], ['locked'], ['staffer']),
    ...expand('R5', ['default'], ['locked'], ['organizer']),
    ...expand('R6', ['default', 'nosend'], ['open', 'locked'], ['admin']),
    ...expand('R7', ['nosend'], ['locked'], ['sendrole']),
    ...(['staffer', 'outsider'] as const).map((s) =>
      effectiveCase('R8', 'default', 'category', s, null, {
        category: { overwrites: categoryOverwritesFor(s) },
        createdUnderCategoryWithoutOverwrites: true,
        genieWrites: null,
      }),
    ),
    effectiveCase('R9', 'default', 'category', 'outsider', null, {
      category: { overwrites: [overwrite('everyone', { deny: ['ViewChannel'] }), genieOverwrite(), stafferOpen('member:other')] },
      genieWrites: [openProfile(false).filter((o) => o.target !== 'everyone')],
    }),
    ...expand('R10', ['default'], ['open'], ['staffer', 'outsider'], ['public']),
    ...expand('R11', ['default'], ['open'], ['staffer'], ['private-added', 'private-notadded']),
    ...expand('R12', ['default'], ['locked'], ['staffer', 'admin'], ['public', 'public-archived', 'private-added']),
  ];
}

function writeCase(c: Omit<WriteCase, 'kind' | 'roles' | 'otherRoles'> & Partial<Pick<WriteCase, 'roles' | 'otherRoles'>>): WriteCase {
  return { kind: 'write', roles: [ORGANIZER], otherRoles: [], ...c };
}

function writeRows(): WriteCase[] {
  const bases: Base[] = ['default', 'nosend'];
  const mr = [true, false] as const;
  const suffix = (m: boolean) => (m ? 'mroverwrite' : 'nomroverwrite');
  return [
    ...bases.flatMap((base) => [
      writeCase({
        id: `W0-${base}-createcategory`, row: 'W0', base, path: 'create', target: 'category',
        mrOverwrite: null, productionRole: 'create', overwritesBefore: [], attempted: categoryProfile(),
      }),
      writeCase({
        id: `W0-${base}-create`, row: 'W0', base, path: 'create', target: 'channel',
        mrOverwrite: null, productionRole: 'create', overwritesBefore: [], attempted: openProfile(false),
      }),
    ]),
    ...bases.flatMap((base) =>
      mr.map((m) =>
        writeCase({
          id: `W1-${base}-${suffix(m)}`, row: 'W1', base, path: 'edit', target: 'channel', mrOverwrite: m,
          productionRole: m ? 'edit' : 'fallback', overwritesBefore: m ? [genieOverwrite()] : [], attempted: openProfile(false),
        }),
      ),
    ),
    ...bases.flatMap((base) =>
      mr.map((m) =>
        writeCase({
          id: `W2-${base}-${suffix(m)}`, row: 'W2', base, path: 'edit', target: 'channel', mrOverwrite: m,
          productionRole: m ? 'edit' : null, overwritesBefore: m ? openProfile(false) : [], attempted: lockedProfile(false),
        }),
      ),
    ),
    writeCase({
      id: 'W3-default-mroverwrite', row: 'W3', base: 'default', path: 'edit', target: 'channel', mrOverwrite: true,
      productionRole: null, roles: [ORGANIZER, HIGH], overwritesBefore: [genieOverwrite()],
      attempted: [genieOverwrite(), overwrite('role:high', { allow: ['ViewChannel'] })],
    }),
    writeCase({
      id: 'W4-default-mroverwrite', row: 'W4', base: 'default', path: 'edit', target: 'channel', mrOverwrite: true,
      productionRole: null, roles: [ORGANIZER, HIGH], otherRoles: ['role:high'], overwritesBefore: [genieOverwrite()],
      attempted: [genieOverwrite(), overwrite('member:other', { allow: ['ViewChannel'] })],
    }),
    ...mr.map((m) =>
      writeCase({
        id: `W5-default-${suffix(m)}`, row: 'W5', base: 'default', path: 'edit', target: 'channel', mrOverwrite: m,
        productionRole: null, overwritesBefore: m ? [genieOverwrite()] : [],
        attempted: [...(m ? [genieOverwrite()] : []), overwrite('member:other', { allow: ['ViewChannel'], allowOther: ['MentionEveryone'] })],
      }),
    ),
  ];
}

/** Write cases first: a production-context refusal stops a pass before any effective case runs (FR-22). */
export function buildCatalog(): Case[] {
  return [...writeRows(), ...effectiveRows()];
}

export function findCase(id: string): Case | undefined {
  return buildCatalog().find((c) => c.id === id);
}
