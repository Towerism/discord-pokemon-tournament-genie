import {
  categoryProfile,
  genieOverwrite,
  lockedProfile,
  openProfile,
  originalGenieOverwrite,
  originalOpenProfile,
  overwrite,
  stafferOpen,
} from './profiles.js';
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

function writeCase(
  c: Omit<WriteCase, 'kind' | 'roles' | 'otherRoles' | 'topLevel'> & Partial<Pick<WriteCase, 'roles' | 'otherRoles' | 'topLevel'>>,
): WriteCase {
  return { kind: 'write', roles: [ORGANIZER], otherRoles: [], topLevel: false, ...c };
}

const edit = (id: string, c: Partial<WriteCase> & Pick<WriteCase, 'overwritesBefore' | 'attempted'>) =>
  writeCase({ id, row: id.split('-')[0]!, base: 'default', path: 'edit', target: 'channel', productionRole: null, ...c });

/** W6: genie creates a top-level channel carrying exactly one overwrite set. */
const diagnosticCreate = (variant: string, attempted: WriteCase['attempted']) =>
  writeCase({
    id: `W6-default-${variant}`, row: 'W6', base: 'default', path: 'create', target: 'channel', topLevel: true,
    productionRole: null, overwritesBefore: [], attempted,
  });

function writeRows(): WriteCase[] {
  const bases: Base[] = ['default', 'nosend'];
  return [
    ...bases.flatMap((base) => [
      writeCase({
        id: `W0-${base}-createcategory`, row: 'W0', base, path: 'create', target: 'category',
        productionRole: 'create', overwritesBefore: [], attempted: categoryProfile(),
      }),
      writeCase({
        id: `W0-${base}-create`, row: 'W0', base, path: 'create', target: 'channel',
        productionRole: 'create', overwritesBefore: [], attempted: openProfile(false),
      }),
    ]),
    ...bases.flatMap((base) => [
      edit(`W1-${base}-sync`, { base, productionRole: 'edit', overwritesBefore: openProfile(false), attempted: openProfile(false) }),
      edit(`W1-${base}-fallback`, { base, productionRole: 'fallback', overwritesBefore: [], attempted: openProfile(false) }),
    ]),
    ...bases.map((base) =>
      edit(`W2-${base}-lock`, { base, productionRole: 'edit', overwritesBefore: openProfile(false), attempted: lockedProfile(false) }),
    ),
    edit('W3-default-edit', {
      roles: [ORGANIZER, HIGH], overwritesBefore: [genieOverwrite()],
      attempted: [genieOverwrite(), overwrite('role:high', { allow: ['ViewChannel'] })],
    }),
    edit('W4-default-edit', {
      roles: [ORGANIZER, HIGH], otherRoles: ['role:high'], overwritesBefore: [genieOverwrite()],
      attempted: [genieOverwrite(), overwrite('member:other', { allow: ['ViewChannel'] })],
    }),
    edit('W5-default-edit', {
      overwritesBefore: [genieOverwrite()],
      attempted: [genieOverwrite(), overwrite('member:other', { allow: ['ViewChannel'], allowOther: ['MentionEveryone'] })],
    }),
    diagnosticCreate('control', [genieOverwrite()]),
    diagnosticCreate('mrself', [overwrite('member:genie', { allowOther: ['ManageRoles'] })]),
    diagnosticCreate('lacksallow', [overwrite('member:other', { allowOther: ['MentionEveryone'] })]),
    diagnosticCreate('lacksdeny', [overwrite('member:other', { denyOther: ['MentionEveryone'] })]),
    diagnosticCreate('original', originalOpenProfile(false)),
    edit('W7-default-originalmr', { overwritesBefore: [originalGenieOverwrite()], attempted: originalOpenProfile(false) }),
  ];
}

/** Write cases first: a production-context refusal stops a pass before any effective case runs. */
export function buildCatalog(): Case[] {
  return [...writeRows(), ...effectiveRows()];
}

export function findCase(id: string): Case | undefined {
  return buildCatalog().find((c) => c.id === id);
}
