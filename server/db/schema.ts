import { sql } from 'drizzle-orm';
import { blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Times are epoch milliseconds. Discord IDs (snowflakes) are TEXT (architecture §3).

/** The install itself: one row, id 1. */
export const install = sqliteTable(
  'install',
  {
    id: integer('id').primaryKey(),
    ownerDiscordUserId: text('owner_discord_user_id'),
    discordClientId: text('discord_client_id'),
    setupCompletedAt: integer('setup_completed_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [check('install_single_row', sql`${t.id} = 1`)],
);

export const SEALED_SECRET_NAMES = ['discord_bot_token', 'discord_client_secret'] as const;
export type SealedSecretName = (typeof SEALED_SECRET_NAMES)[number];

/** Vault blobs (kit blob v1), each bound to its row with the AAD `sealed_secret:<name>`. */
export const sealedSecret = sqliteTable(
  'sealed_secret',
  {
    name: text('name', { enum: SEALED_SECRET_NAMES }).primaryKey(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('sealed_secret_name', sql`${t.name} in ('discord_bot_token', 'discord_client_secret')`)],
);

/** The one guild this install serves (§5.1). At most one row. */
export const guildBinding = sqliteTable(
  'guild_binding',
  {
    guildId: text('guild_id').primaryKey(),
    name: text('name').notNull(),
    organizerRoleId: text('organizer_role_id'),
    headJudgeRoleId: text('head_judge_role_id'),
    organizerAllowlistEnabled: integer('organizer_allowlist_enabled', { mode: 'boolean' }).notNull().default(false),
    boundAt: integer('bound_at').notNull(),
  },
  (t) => [check('guild_binding_allowlist_flag', sql`${t.organizerAllowlistEnabled} in (0, 1)`)],
);

export const organizerAllowlist = sqliteTable('organizer_allowlist', {
  discordUserId: text('discord_user_id').primaryKey(),
  addedAt: integer('added_at').notNull(),
});

export const GRANTS = ['owner', 'organizer_role', 'allowlist', 'event_head_judge'] as const;

/** One row per website login, with the grant that admitted it (§9). */
export const loginAudit = sqliteTable(
  'login_audit',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    discordUserId: text('discord_user_id').notNull(),
    grant: text('grant', { enum: GRANTS }).notNull(),
    at: integer('at').notNull(),
  },
  (t) => [
    index('login_audit_user').on(t.discordUserId),
    check('login_audit_grant', sql`${t.grant} in ('owner', 'organizer_role', 'allowlist', 'event_head_judge')`),
  ],
);

export const JOB_KINDS = [
  'provision',
  'sync',
  'lock',
  'export',
  'reexport',
  'attachments_retry',
  'purge',
  'retention_sweep',
  'attendance_import',
] as const;
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'] as const;

// ---- M2: directory, blueprints, templates, days (§5.2). Owners: directory, event-days, provisioning (§3).

export const LINK_STATES = ['unlinked', 'claimed', 'linked'] as const;

/** The directory (§5.3): one person, at most one Discord account and one player ID. */
export const staffMember = sqliteTable(
  'staff_member',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    displayName: text('display_name').notNull(),
    playerId: text('player_id').unique(),
    discordUserId: text('discord_user_id').unique(),
    claimedDiscordUserId: text('claimed_discord_user_id').unique(),
    claimedAt: integer('claimed_at'),
    createdByClaim: integer('created_by_claim', { mode: 'boolean' }).notNull().default(false),
    linkState: text('link_state', { enum: LINK_STATES }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('staff_member_link_state', sql`${t.linkState} in ('unlinked', 'claimed', 'linked')`),
    check(
      'staff_member_link_consistent',
      sql`(${t.linkState} = 'linked' and ${t.discordUserId} is not null and ${t.claimedDiscordUserId} is null)
       or (${t.linkState} = 'claimed' and ${t.discordUserId} is null and ${t.claimedDiscordUserId} is not null)
       or (${t.linkState} = 'unlinked' and ${t.discordUserId} is null and ${t.claimedDiscordUserId} is null)`,
    ),
  ],
);

export const SCOPES = ['day', 'per_event'] as const;
export const CHANNEL_KINDS = ['text', 'voice'] as const;
export const AUDIENCES = ['all_staff', 'event_staff', 'head_judges'] as const;
export const PURPOSES = ['general', 'floor', 'penalties'] as const;
export const GAMES = ['tcg', 'vgc', 'go', 'other'] as const;
export const EVENT_ROLES = ['headjudge', 'judge', 'scorekeeper', 'administration', 'translator'] as const;
export const DAY_STATES = ['draft', 'open', 'closing', 'closed', 'purged'] as const;

export const blueprint = sqliteTable(
  'blueprint',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull().unique(),
    categoryNamePattern: text('category_name_pattern').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('blueprint_default_flag', sql`${t.isDefault} in (0, 1)`),
    uniqueIndex('blueprint_one_default').on(t.isDefault).where(sql`${t.isDefault} = 1`),
  ],
);

export const blueprintChannel = sqliteTable(
  'blueprint_channel',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    blueprintId: integer('blueprint_id')
      .notNull()
      .references(() => blueprint.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    scope: text('scope', { enum: SCOPES }).notNull(),
    kind: text('kind', { enum: CHANNEL_KINDS }).notNull(),
    namePattern: text('name_pattern').notNull(),
    audience: text('audience', { enum: AUDIENCES }).notNull(),
    purpose: text('purpose', { enum: PURPOSES }).notNull(),
    topic: text('topic'),
    position: integer('position').notNull(),
  },
  (t) => [
    uniqueIndex('blueprint_channel_key').on(t.blueprintId, t.key),
    check('blueprint_channel_scope', sql`${t.scope} in ('day', 'per_event')`),
    check('blueprint_channel_kind', sql`${t.kind} in ('text', 'voice')`),
    check('blueprint_channel_audience', sql`${t.audience} in ('all_staff', 'event_staff', 'head_judges')`),
    check('blueprint_channel_purpose', sql`${t.purpose} in ('general', 'floor', 'penalties')`),
  ],
);

export const dayTemplate = sqliteTable('day_template', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  blueprintId: integer('blueprint_id')
    .notNull()
    .references(() => blueprint.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const dayTemplateEvent = sqliteTable(
  'day_template_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    templateId: integer('template_id')
      .notNull()
      .references(() => dayTemplate.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    game: text('game', { enum: GAMES }).notNull(),
    /** `HH:MM`, store-TZ local time. */
    startTime: text('start_time').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [check('day_template_event_game', sql`${t.game} in ('tcg', 'vgc', 'go', 'other')`)],
);

/** An event day. The state never moves backwards (§5.2); revisions drive sync state and the revocation alarm. */
export const eventDay = sqliteTable(
  'event_day',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    guildId: text('guild_id').notNull(),
    /** Store-TZ `YYYY-MM-DD`. */
    date: text('date').notNull(),
    title: text('title').notNull(),
    blueprintId: integer('blueprint_id')
      .notNull()
      .references(() => blueprint.id, { onDelete: 'restrict' }),
    state: text('state', { enum: DAY_STATES }).notNull().default('draft'),
    categoryId: text('category_id'),
    planRevision: integer('plan_revision').notNull().default(1),
    appliedRevision: integer('applied_revision'),
    revokePendingRevision: integer('revoke_pending_revision'),
    revokePendingAt: integer('revoke_pending_at'),
    openedAt: integer('opened_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('event_day_state').on(t.state),
    index('event_day_date').on(t.date),
    check('event_day_state', sql`${t.state} in ('draft', 'open', 'closing', 'closed', 'purged')`),
  ],
);

export const event = sqliteTable(
  'event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    game: text('game', { enum: GAMES }).notNull(),
    gameConfirmed: integer('game_confirmed', { mode: 'boolean' }).notNull().default(true),
    startsAt: integer('starts_at').notNull(),
    tournamentId: text('tournament_id'),
    position: integer('position').notNull().default(0),
  },
  (t) => [
    uniqueIndex('event_day_slug').on(t.dayId, t.slug),
    check('event_game', sql`${t.game} in ('tcg', 'vgc', 'go', 'other')`),
    check('event_game_confirmed', sql`${t.gameConfirmed} in (0, 1)`),
  ],
);

export const dayStaff = sqliteTable(
  'day_staff',
  {
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'cascade' }),
    staffMemberId: integer('staff_member_id')
      .notNull()
      .references(() => staffMember.id, { onDelete: 'restrict' }),
  },
  (t) => [primaryKey({ columns: [t.dayId, t.staffMemberId] })],
);

export const eventStaff = sqliteTable(
  'event_staff',
  {
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'cascade' }),
    staffMemberId: integer('staff_member_id')
      .notNull()
      .references(() => staffMember.id, { onDelete: 'restrict' }),
    role: text('role', { enum: EVENT_ROLES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.staffMemberId] }),
    check('event_staff_role', sql`${t.role} in ('headjudge', 'judge', 'scorekeeper', 'administration', 'translator')`),
  ],
);

export const PROVISIONED_STATES = ['present', 'missing', 'deleted'] as const;

/**
 * The only record of which Discord channels Genie owns (§5.2). The "one present row per day, event and key" index
 * is an expression index, hand-written in the migration (drizzle-kit can't express it).
 */
export const provisionedChannel = sqliteTable(
  'provisioned_channel',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'restrict' }),
    guildId: text('guild_id').notNull(),
    eventId: integer('event_id').references(() => event.id, { onDelete: 'restrict' }),
    blueprintChannelKey: text('blueprint_channel_key').notNull(),
    discordChannelId: text('discord_channel_id').notNull().unique(),
    appliedOverwritesHash: text('applied_overwrites_hash').notNull(),
    state: text('state', { enum: PROVISIONED_STATES }).notNull(),
    messageId: text('message_id'),
    messagePinned: integer('message_pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('provisioned_channel_day').on(t.dayId),
    check('provisioned_channel_state', sql`${t.state} in ('present', 'missing', 'deleted')`),
  ],
);

/** Channels (or categories) Genie found but didn't record: listed for the organizer, never touched on its own. */
export const orphanChannel = sqliteTable(
  'orphan_channel',
  {
    discordChannelId: text('discord_channel_id').primaryKey(),
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'restrict' }),
    guildId: text('guild_id').notNull(),
    kind: text('kind', { enum: ['channel', 'category'] }).notNull(),
    name: text('name').notNull(),
    foundAt: integer('found_at').notNull(),
  },
  (t) => [index('orphan_channel_day').on(t.dayId), check('orphan_channel_kind', sql`${t.kind} in ('channel', 'category')`)],
);

/** Owned by the jobs module alone (§3). */
export const job = sqliteTable(
  'job',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    state: text('state', { enum: JOB_STATES }).notNull(),
    dayId: integer('day_id').references(() => eventDay.id),
    payload: text('payload'),
    dueAt: integer('due_at'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('job_state_due').on(t.state, t.dueAt),
    index('job_day_state').on(t.dayId, t.state),
    check(
      'job_kind',
      sql`${t.kind} in ('provision', 'sync', 'lock', 'export', 'reexport', 'attachments_retry', 'purge', 'retention_sweep', 'attendance_import')`,
    ),
    check('job_state', sql`${t.state} in ('queued', 'running', 'succeeded', 'failed', 'interrupted')`),
  ],
);

export const jobEvent = sqliteTable(
  'job_event',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    at: integer('at').notNull(),
    level: text('level', { enum: ['info', 'warn', 'error'] }).notNull(),
    message: text('message').notNull(),
    data: text('data'),
  },
  (t) => [index('job_event_job').on(t.jobId), check('job_event_level', sql`${t.level} in ('info', 'warn', 'error')`)],
);
