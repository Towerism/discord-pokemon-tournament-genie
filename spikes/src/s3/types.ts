/** The seven channel permissions the fake models (ADR-0003). */
export const PERMISSIONS = [
  'ViewChannel',
  'ReadMessageHistory',
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
] as const;
export type PermissionName = (typeof PERMISSIONS)[number];

/** The five permissions §6.5's lock denies explicitly. */
export const LOCK_DENIES: PermissionName[] = [
  'SendMessages',
  'SendMessagesInThreads',
  'CreatePublicThreads',
  'CreatePrivateThreads',
  'AddReactions',
];

/** Fixed order: read-only first, thread-state-neutral next, `send` (which can unarchive) last. */
export const CHANNEL_ACTIONS = [
  'view',
  'readHistory',
  'reactExisting',
  'reactNew',
  'createPublicThread',
  'createPrivateThread',
  'send',
] as const;
export const THREAD_ACTIONS = ['view', 'readHistory', 'reactExisting', 'reactNew', 'send'] as const;
export type Action = (typeof CHANNEL_ACTIONS)[number];

export type MemberKey = 'member:subject' | 'member:other' | 'member:genie';
export type OverwriteTarget = 'everyone' | `role:${string}` | MemberKey;

export type Overwrite = {
  target: OverwriteTarget;
  allow: PermissionName[];
  deny: PermissionName[];
  /** Permissions outside the modelled seven (Manage Channels, Manage Roles, Attach Files, …). */
  allowOther: string[];
  denyOther: string[];
};

export type Base = 'default' | 'nosend';
export type Profile = 'open' | 'locked' | 'category';
export type Subject = 'outsider' | 'staffer' | 'organizer' | 'admin' | 'sendrole';
export type ThreadVariant = 'public' | 'public-archived' | 'private-added' | 'private-notadded';

export type RoleSpec = {
  key: `role:${string}`;
  /** Relative position among the case's roles, 0 = lowest; `aboveGenie` places it over genie's role. */
  position: number;
  aboveGenie?: boolean;
  permissions: string[];
};

export type EffectiveCase = {
  kind: 'effective';
  id: string;
  row: string;
  base: Base;
  profile: Profile;
  subject: Subject;
  thread: ThreadVariant | null;
  roles: RoleSpec[];
  subjectRoles: `role:${string}`[];
  otherRoles: `role:${string}`[];
  /** Overwrites the arranger (an administrator) puts on the category; null = no category. */
  category: { overwrites: Overwrite[] } | null;
  /** True for R8: the channel is created under the category with no overwrites, through raw REST. */
  createdUnderCategoryWithoutOverwrites: boolean;
  /** Full-replace writes genie makes, in order; null = genie writes nothing (R8). */
  genieWrites: Overwrite[][] | null;
  actions: readonly Action[];
};

export type ProductionRole = 'create' | 'edit' | 'fallback' | null;

export type WriteCase = {
  kind: 'write';
  id: string;
  row: string;
  base: Base;
  path: 'create' | 'edit';
  target: 'category' | 'channel';
  /** A create with no parent category, so no parent's overwrites take part (the diagnostics). */
  topLevel: boolean;
  productionRole: ProductionRole;
  roles: RoleSpec[];
  otherRoles: `role:${string}`[];
  overwritesBefore: Overwrite[];
  attempted: Overwrite[];
};

export type Case = EffectiveCase | WriteCase;

export type Outcome =
  | { kind: 'http'; status: number; code?: number; body?: unknown }
  | { kind: 'network'; message: string };

export type Observation = 'allowed' | 'denied' | 'blocked_archived' | 'inconclusive';
export type Effective = boolean | 'unobservable';

export type ObservationRecord = {
  result: Exclude<Observation, 'inconclusive'>;
  status: number;
  code?: number;
  archivedAfter?: boolean;
};

export type CaseResult = {
  caseId: string;
  status: 'ok' | 'arrange_failed' | 'inconclusive';
  failure?: string;
  categoryOverwrites: Overwrite[] | null;
  channelOverwrites: Overwrite[];
  observed: Partial<Record<Action, ObservationRecord>>;
  effective: Record<PermissionName, Effective>;
  computedByLibrary: Record<PermissionName, boolean>;
};

export type WriteCaseRecord = {
  caseId: string;
  result: 'ok' | 'refused';
  code?: number;
  status?: number;
  stored?: Overwrite[];
};

export type PassResult = {
  passId: string;
  writes: WriteCaseRecord[];
  cases: CaseResult[];
  stop?: { reason: 'profile_unwritable'; caseIds: string[] };
  amendmentRequired: string[];
};
