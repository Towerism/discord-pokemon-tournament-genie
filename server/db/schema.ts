import { sql } from 'drizzle-orm';
import { type AnySQLiteColumn, blob, check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

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

export const SEALED_SECRET_NAMES = ['discord_bot_token', 'discord_client_secret', 'attendance_token'] as const;
export type SealedSecretName = (typeof SEALED_SECRET_NAMES)[number];

/** Vault blobs (kit blob v1), each bound to its row with the AAD `sealed_secret:<name>`. */
export const sealedSecret = sqliteTable(
  'sealed_secret',
  {
    name: text('name', { enum: SEALED_SECRET_NAMES }).primaryKey(),
    ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('sealed_secret_name', sql`${t.name} in ('discord_bot_token', 'discord_client_secret', 'attendance_token')`)],
);

/** Where attendance answers (§4.2): one row, id 1. The token itself is the sealed `attendance_token`. */
export const attendanceConnection = sqliteTable(
  'attendance_connection',
  {
    id: integer('id').primaryKey(),
    baseUrl: text('base_url').notNull(),
    tokenHint: text('token_hint').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('attendance_connection_single_row', sql`${t.id} = 1`)],
);

/** Install-wide settings (§5.2): one row, id 1. New days copy the current season, which selects the penalty catalog. */
export const appSetting = sqliteTable(
  'app_setting',
  {
    id: integer('id').primaryKey(),
    currentSeason: text('current_season').notNull(),
    /** Close-out (§6.5, §15 Q3): how long transcripts and penalty data are kept after a day closes, and the attachment cap. */
    transcriptRetentionDays: integer('transcript_retention_days').notNull().default(90),
    penaltyRetentionDays: integer('penalty_retention_days').notNull().default(365),
    attachmentCapBytes: integer('attachment_cap_bytes').notNull().default(26_214_400),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [check('app_setting_single_row', sql`${t.id} = 1`)],
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
export const AUDIENCES = ['all_staff', 'event_staff', 'head_judges', 'streaming'] as const;
export const PURPOSES = ['general', 'floor', 'penalties'] as const;
export const GAMES = ['tcg', 'vgc', 'go', 'other'] as const;
export const EVENT_ROLES = ['headjudge', 'judge', 'scorekeeper', 'administration', 'translator', 'streaming'] as const;
export const DAY_STATES = ['draft', 'open', 'closing', 'closed', 'purged'] as const;
export const DAY_SOURCES = ['manual', 'attendance'] as const;

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
    check('blueprint_channel_audience', sql`${t.audience} in ('all_staff', 'event_staff', 'head_judges', 'streaming')`),
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

/**
 * An event day. The state never moves backwards (§5.2); revisions drive sync state and the revocation alarm.
 *
 * Migrations: never let drizzle-kit rebuild this table (or `event`, `day_staff`, `event_staff`). The migrator runs in
 * a transaction, where PRAGMA foreign_keys=OFF does nothing, so dropping it cascade-deletes every event and its staff.
 * Hand-write column additions instead (see 0002_m3_attendance_import.sql).
 */
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
    /** `attendance` once an import was accepted (§4.2). */
    source: text('source', { enum: DAY_SOURCES }).notNull().default('manual'),
    attendanceRefreshedAt: integer('attendance_refreshed_at'),
    /** Copied from the current season when the day is created, never changed: it selects the penalty catalog. */
    season: text('season').notNull().default('2026-27'),
    /** Close-out (§6.5): when the day moved to `closing`, `closed` and `purged`, who closed it, and the grace end. */
    closingAt: integer('closing_at'),
    closedBy: text('closed_by'),
    closedAt: integer('closed_at'),
    graceUntil: integer('grace_until'),
    purgedAt: integer('purged_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('event_day_state').on(t.state),
    index('event_day_date').on(t.date),
    check('event_day_state', sql`${t.state} in ('draft', 'open', 'closing', 'closed', 'purged')`),
    check('event_day_source', sql`${t.source} in ('manual', 'attendance')`),
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
    /** The tournament an import created it from; cleared when a refresh retires it (§4.2). */
    attendanceTournamentId: text('attendance_tournament_id'),
    attendanceOrganizerPlayerId: text('attendance_organizer_player_id'),
    attendanceOrganizerName: text('attendance_organizer_name'),
  },
  (t) => [
    uniqueIndex('event_day_slug').on(t.dayId, t.slug),
    uniqueIndex('event_day_tournament').on(t.dayId, t.attendanceTournamentId).where(sql`${t.attendanceTournamentId} is not null`),
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
    /** An import put them on the day: a refresh may take them off again, never someone added by hand. */
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.dayId, t.staffMemberId] }), check('day_staff_imported', sql`${t.imported} in (0, 1)`)],
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
    /** An import created this role: only such roles are ever proposed for removal by a refresh. */
    imported: integer('imported', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.staffMemberId] }),
    check('event_staff_role', sql`${t.role} in ('headjudge', 'judge', 'scorekeeper', 'administration', 'translator', 'streaming')`),
    check('event_staff_imported', sql`${t.imported} in (0, 1)`),
  ],
);

export const SEVERITIES = ['Minor', 'Major', 'Severe'] as const;
export const PENALTY_STATES = ['active', 'voided'] as const;
export const CARD_STATES = ['pending', 'posted', 'failed', 'missing', 'none'] as const;
export const REVISION_ACTIONS = ['recorded', 'edited', 'voided'] as const;

/**
 * The penalty catalog as data (ADR-0006): one row per label per season, never deleted (penalties refer to it), only
 * deactivated. `games` is a JSON array of game codes. "Unique label per season, any case" is an expression index,
 * hand-written in the migration.
 */
const catalogColumns = {
  id: integer('id').primaryKey({ autoIncrement: true }),
  season: text('season').notNull(),
  label: text('label').notNull(),
  games: text('games').notNull(),
  rank: integer('rank').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
};

export const penaltyCategory = sqliteTable('penalty_category', catalogColumns, (t) => [
  index('penalty_category_season').on(t.season),
  check('penalty_category_active', sql`${t.active} in (0, 1)`),
]);

export const penaltyType = sqliteTable('penalty_type', catalogColumns, (t) => [
  index('penalty_type_season').on(t.season),
  check('penalty_type_active', sql`${t.active} in (0, 1)`),
]);

/**
 * One row per future CSV line (§5.2, ADR-0006). No competitor name, ever. The Discord card is a view of the row;
 * `card_state` records what Discord last did with it. Owned by `penalties`.
 */
export const penalty = sqliteTable(
  'penalty',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    eventId: integer('event_id')
      .notNull()
      .references(() => event.id, { onDelete: 'restrict' }),
    /** Per event, from 1, never reused: what judges call it ("#12"). */
    number: integer('number').notNull(),
    /** `discord:<command interaction ID>` or `web:<UUID>`: a repeated submission returns the existing row. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    round: integer('round').notNull(),
    competitorPlayerId: text('competitor_player_id').notNull(),
    categoryId: integer('category_id')
      .notNull()
      .references(() => penaltyCategory.id, { onDelete: 'restrict' }),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    penaltyTypeId: integer('penalty_type_id')
      .notNull()
      .references(() => penaltyType.id, { onDelete: 'restrict' }),
    notes: text('notes').notNull().default(''),
    judgeStaffId: integer('judge_staff_id')
      .notNull()
      .references(() => staffMember.id, { onDelete: 'restrict' }),
    /** Copied when recorded (and when the judge changes): the CSV's Judge Player ID as of then. */
    judgePlayerId: text('judge_player_id').notNull(),
    /** The Discord user who recorded it (the judge in Discord; a head judge or organizer on the website). */
    recordedBy: text('recorded_by').notNull(),
    recordedAt: integer('recorded_at').notNull(),
    state: text('state', { enum: PENALTY_STATES }).notNull().default('active'),
    voidReason: text('void_reason'),
    revision: integer('revision').notNull(),
    discordChannelId: text('discord_channel_id'),
    discordMessageId: text('discord_message_id'),
    cardState: text('card_state', { enum: CARD_STATES }).notNull(),
  },
  (t) => [
    uniqueIndex('penalty_event_number').on(t.eventId, t.number),
    index('penalty_event_state').on(t.eventId, t.state),
    check('penalty_round', sql`${t.round} between 1 and 99`),
    check('penalty_severity', sql`${t.severity} in ('Minor', 'Major', 'Severe')`),
    check('penalty_state', sql`${t.state} in ('active', 'voided')`),
    check('penalty_card_state', sql`${t.cardState} in ('pending', 'posted', 'failed', 'missing', 'none')`),
  ],
);

/** Every change to a penalty, as a full snapshot (§5.2): edits and voids are auditable. */
export const penaltyRevision = sqliteTable(
  'penalty_revision',
  {
    penaltyId: integer('penalty_id')
      .notNull()
      .references(() => penalty.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    action: text('action', { enum: REVISION_ACTIONS }).notNull(),
    /** The row's fields as JSON, without the card columns. */
    snapshot: text('snapshot').notNull(),
    editedBy: text('edited_by').notNull(),
    editedAt: integer('edited_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.penaltyId, t.revision] }), check('penalty_revision_action', sql`${t.action} in ('recorded', 'edited', 'voided')`)],
);

/** The latest pull of a day from attendance, waiting to be accepted. Owned by `attendance-import`. */
export const attendanceSnapshot = sqliteTable(
  'attendance_snapshot',
  {
    dayId: integer('day_id')
      .primaryKey()
      .references(() => eventDay.id, { onDelete: 'cascade' }),
    snapshotId: text('snapshot_id').notNull().unique(),
    payload: text('payload').notNull(),
    planRevision: integer('plan_revision').notNull(),
    dayState: text('day_state', { enum: ['draft', 'open'] }).notNull(),
    fetchedAt: integer('fetched_at').notNull(),
    fetchedBy: text('fetched_by').notNull(),
  },
  (t) => [check('attendance_snapshot_day_state', sql`${t.dayState} in ('draft', 'open')`)],
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
    /** The close-out lock reached this channel (§6.5): a retried lock never writes it again. */
    lockedAt: integer('locked_at'),
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

// ---- M5: close-out (§5.2, §6.5, ADR-0007). Owner: closeout.

export const EXPORT_RUN_KINDS = ['export', 'reexport', 'attachments_retry', 'correction'] as const;
export const EXPORT_RUN_STATES = ['running', 'succeeded', 'failed'] as const;
export const EXPORT_FILE_KINDS = [
  'penalties_csv',
  'penalties_voided_csv',
  'transcript_json',
  'transcript_html',
  'thread_transcript_json',
  'thread_transcript_html',
  'attachment',
] as const;
export const ATTACHMENT_STATES = ['saved', 'skipped', 'discarded'] as const;
export const SKIP_REASONS = ['over_cap', 'download_failed', 'message_deleted'] as const;

/** A day's close-out state beyond its `event_day.state`: the last refusal, the last failure, Genie's alert posts. */
export const dayCloseout = sqliteTable('day_closeout', {
  dayId: integer('day_id')
    .primaryKey()
    .references(() => eventDay.id, { onDelete: 'restrict' }),
  /** JSON: the reasons of the last refused purge, until a purge succeeds. */
  purgeRefusal: text('purge_refusal'),
  purgeRefusedAt: integer('purge_refused_at'),
  /** JSON `{ kind, error, at }` of the newest failed close-out job (or correction), until that kind succeeds. */
  lastFailure: text('last_failure'),
  failurePostedAt: integer('failure_posted_at'),
  /** JSON: Genie's own `#head-judges` alert posts, which the purge's high-water check ignores. */
  alertMessageIds: text('alert_message_ids').notNull().default('[]'),
  transcriptsSweptAt: integer('transcripts_swept_at'),
  penaltiesSweptAt: integer('penalties_swept_at'),
});

/** One export, re-export, attachment retry or correction. Its files are current only once it `succeeded`. */
export const exportRun = sqliteTable(
  'export_run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: EXPORT_RUN_KINDS }).notNull(),
    /** The job that ran it (no FK: the jobs module owns `job`); null for a correction. */
    jobId: integer('job_id'),
    eventId: integer('event_id'),
    state: text('state', { enum: EXPORT_RUN_STATES }).notNull(),
    contentIntent: integer('content_intent', { mode: 'boolean' }),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [
    index('export_run_day_state').on(t.dayId, t.state),
    check('export_run_kind', sql`${t.kind} in ('export', 'reexport', 'attachments_retry', 'correction')`),
    check('export_run_state', sql`${t.state} in ('running', 'succeeded', 'failed')`),
  ],
);

/** A file under `<exportsDir>/` (§5.2). Current: its run succeeded and nothing supersedes it. */
export const exportFile = sqliteTable(
  'export_file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dayId: integer('day_id')
      .notNull()
      .references(() => eventDay.id, { onDelete: 'restrict' }),
    runId: integer('run_id')
      .notNull()
      .references(() => exportRun.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: EXPORT_FILE_KINDS }).notNull(),
    eventId: integer('event_id').references(() => event.id, { onDelete: 'restrict' }),
    channelId: text('channel_id'),
    threadId: text('thread_id'),
    parentChannelId: text('parent_channel_id'),
    blueprintChannelKey: text('blueprint_channel_key'),
    threadType: text('thread_type', { enum: ['public', 'private'] }),
    attachmentId: text('attachment_id'),
    /** A CSV's penalty state: the event's highest `penalty_revision` rowid when it was built (0: none). */
    sourceRevision: integer('source_revision'),
    name: text('name').notNull(),
    highWaterMessageId: text('high_water_message_id'),
    /** Relative to the exports folder. */
    path: text('path').notNull(),
    downloadName: text('download_name').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt: integer('created_at').notNull(),
    supersededBy: integer('superseded_by').references((): AnySQLiteColumn => exportFile.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('export_file_day').on(t.dayId, t.supersededBy),
    index('export_file_run').on(t.runId),
    check(
      'export_file_kind',
      sql`${t.kind} in ('penalties_csv', 'penalties_voided_csv', 'transcript_json', 'transcript_html', 'thread_transcript_json', 'thread_transcript_html', 'attachment')`,
    ),
    check('export_file_thread_type', sql`${t.threadType} is null or ${t.threadType} in ('public', 'private')`),
  ],
);

/** One attachment of a transcript (§5.2). The purge refuses while a current one is `skipped`. */
export const exportAttachment = sqliteTable(
  'export_attachment',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    exportFileId: integer('export_file_id')
      .notNull()
      .references(() => exportFile.id, { onDelete: 'cascade' }),
    attachmentId: text('attachment_id').notNull(),
    messageId: text('message_id').notNull(),
    /** The channel or thread that holds the message. */
    channelId: text('channel_id').notNull(),
    filename: text('filename').notNull(),
    declaredBytes: integer('declared_bytes').notNull(),
    fileId: integer('file_id').references(() => exportFile.id, { onDelete: 'set null' }),
    state: text('state', { enum: ATTACHMENT_STATES }).notNull(),
    reason: text('reason', { enum: SKIP_REASONS }),
    discardedBy: text('discarded_by'),
    discardedAt: integer('discarded_at'),
  },
  (t) => [
    uniqueIndex('export_attachment_file_attachment').on(t.exportFileId, t.attachmentId),
    check('export_attachment_state', sql`${t.state} in ('saved', 'skipped', 'discarded')`),
    check('export_attachment_reason', sql`${t.reason} is null or ${t.reason} in ('over_cap', 'download_failed', 'message_deleted')`),
  ],
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
