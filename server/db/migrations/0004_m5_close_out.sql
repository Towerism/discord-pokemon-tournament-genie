CREATE TABLE `day_closeout` (
	`day_id` integer PRIMARY KEY NOT NULL,
	`purge_refusal` text,
	`purge_refused_at` integer,
	`last_failure` text,
	`failure_posted_at` integer,
	`alert_message_ids` text DEFAULT '[]' NOT NULL,
	`transcripts_swept_at` integer,
	`penalties_swept_at` integer,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `export_attachment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`export_file_id` integer NOT NULL,
	`attachment_id` text NOT NULL,
	`message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`filename` text NOT NULL,
	`declared_bytes` integer NOT NULL,
	`file_id` integer,
	`state` text NOT NULL,
	`reason` text,
	`discarded_by` text,
	`discarded_at` integer,
	FOREIGN KEY (`export_file_id`) REFERENCES `export_file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `export_file`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "export_attachment_state" CHECK("export_attachment"."state" in ('saved', 'skipped', 'discarded')),
	CONSTRAINT "export_attachment_reason" CHECK("export_attachment"."reason" is null or "export_attachment"."reason" in ('over_cap', 'download_failed', 'message_deleted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `export_attachment_file_attachment` ON `export_attachment` (`export_file_id`,`attachment_id`);--> statement-breakpoint
CREATE TABLE `export_file` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`kind` text NOT NULL,
	`event_id` integer,
	`channel_id` text,
	`thread_id` text,
	`parent_channel_id` text,
	`blueprint_channel_key` text,
	`thread_type` text,
	`attachment_id` text,
	`source_revision` integer,
	`name` text NOT NULL,
	`high_water_message_id` text,
	`path` text NOT NULL,
	`download_name` text NOT NULL,
	`sha256` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_by` integer,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`run_id`) REFERENCES `export_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`superseded_by`) REFERENCES `export_file`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "export_file_kind" CHECK("export_file"."kind" in ('penalties_csv', 'penalties_voided_csv', 'transcript_json', 'transcript_html', 'thread_transcript_json', 'thread_transcript_html', 'attachment')),
	CONSTRAINT "export_file_thread_type" CHECK("export_file"."thread_type" is null or "export_file"."thread_type" in ('public', 'private'))
);
--> statement-breakpoint
CREATE INDEX `export_file_day` ON `export_file` (`day_id`,`superseded_by`);--> statement-breakpoint
CREATE INDEX `export_file_run` ON `export_file` (`run_id`);--> statement-breakpoint
CREATE TABLE `export_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day_id` integer NOT NULL,
	`kind` text NOT NULL,
	`job_id` integer,
	`event_id` integer,
	`state` text NOT NULL,
	`content_intent` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`day_id`) REFERENCES `event_day`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "export_run_kind" CHECK("export_run"."kind" in ('export', 'reexport', 'attachments_retry', 'correction')),
	CONSTRAINT "export_run_state" CHECK("export_run"."state" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `export_run_day_state` ON `export_run` (`day_id`,`state`);--> statement-breakpoint
ALTER TABLE `app_setting` ADD `transcript_retention_days` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_setting` ADD `penalty_retention_days` integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE `app_setting` ADD `attachment_cap_bytes` integer DEFAULT 26214400 NOT NULL;--> statement-breakpoint
ALTER TABLE `event_day` ADD `closing_at` integer;--> statement-breakpoint
ALTER TABLE `event_day` ADD `closed_by` text;--> statement-breakpoint
ALTER TABLE `event_day` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `event_day` ADD `grace_until` integer;--> statement-breakpoint
ALTER TABLE `event_day` ADD `purged_at` integer;--> statement-breakpoint
ALTER TABLE `provisioned_channel` ADD `locked_at` integer;