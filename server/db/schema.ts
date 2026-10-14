import { sql } from 'drizzle-orm';
import { blob, check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

/** Owned by the jobs module alone (§3). `day_id` gets its event_day reference with M2's table. */
export const job = sqliteTable(
  'job',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    state: text('state', { enum: JOB_STATES }).notNull(),
    dayId: integer('day_id'),
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
