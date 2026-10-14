CREATE TABLE `guild_binding` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`organizer_role_id` text,
	`head_judge_role_id` text,
	`organizer_allowlist_enabled` integer DEFAULT false NOT NULL,
	`bound_at` integer NOT NULL,
	CONSTRAINT "guild_binding_allowlist_flag" CHECK("guild_binding"."organizer_allowlist_enabled" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `install` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_discord_user_id` text,
	`discord_client_id` text,
	`setup_completed_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "install_single_row" CHECK("install"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`day_id` integer,
	`payload` text,
	`due_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "job_kind" CHECK("job"."kind" in ('provision', 'sync', 'lock', 'export', 'reexport', 'attachments_retry', 'purge', 'retention_sweep', 'attendance_import')),
	CONSTRAINT "job_state" CHECK("job"."state" in ('queued', 'running', 'succeeded', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE INDEX `job_state_due` ON `job` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `job_day_state` ON `job` (`day_id`,`state`);--> statement-breakpoint
CREATE TABLE `job_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`at` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	FOREIGN KEY (`job_id`) REFERENCES `job`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "job_event_level" CHECK("job_event"."level" in ('info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE INDEX `job_event_job` ON `job_event` (`job_id`);--> statement-breakpoint
CREATE TABLE `login_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`discord_user_id` text NOT NULL,
	`grant` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "login_audit_grant" CHECK("login_audit"."grant" in ('owner', 'organizer_role', 'allowlist', 'event_head_judge'))
);
--> statement-breakpoint
CREATE INDEX `login_audit_user` ON `login_audit` (`discord_user_id`);--> statement-breakpoint
CREATE TABLE `organizer_allowlist` (
	`discord_user_id` text PRIMARY KEY NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sealed_secret` (
	`name` text PRIMARY KEY NOT NULL,
	`ciphertext` blob NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sealed_secret_name" CHECK("sealed_secret"."name" in ('discord_bot_token', 'discord_client_secret'))
);
