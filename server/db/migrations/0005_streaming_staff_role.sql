-- Hand-edited: drizzle-kit rebuilds `blueprint_channel` and `event_staff` for their widened CHECKs (the streaming
-- audience and role, ADR-0015). The migrator runs inside a transaction, where PRAGMA foreign_keys=OFF does nothing, so a
-- rebuild cascade-deletes any table that references the one dropped. These two are leaves: no table references either,
-- so the rebuild is safe (tested in server/db/migrations.test.ts, "the streaming staff role migration"). Don't rebuild
-- them this way once something references them. The closing PRAGMA restores what drizzle-kit leaves off.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_blueprint_channel` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`blueprint_id` integer NOT NULL,
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`name_pattern` text NOT NULL,
	`audience` text NOT NULL,
	`purpose` text NOT NULL,
	`topic` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`blueprint_id`) REFERENCES `blueprint`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "blueprint_channel_scope" CHECK("__new_blueprint_channel"."scope" in ('day', 'per_event')),
	CONSTRAINT "blueprint_channel_kind" CHECK("__new_blueprint_channel"."kind" in ('text', 'voice')),
	CONSTRAINT "blueprint_channel_audience" CHECK("__new_blueprint_channel"."audience" in ('all_staff', 'event_staff', 'head_judges', 'streaming')),
	CONSTRAINT "blueprint_channel_purpose" CHECK("__new_blueprint_channel"."purpose" in ('general', 'floor', 'penalties'))
);
--> statement-breakpoint
INSERT INTO `__new_blueprint_channel`("id", "blueprint_id", "key", "scope", "kind", "name_pattern", "audience", "purpose", "topic", "position") SELECT "id", "blueprint_id", "key", "scope", "kind", "name_pattern", "audience", "purpose", "topic", "position" FROM `blueprint_channel`;--> statement-breakpoint
DROP TABLE `blueprint_channel`;--> statement-breakpoint
ALTER TABLE `__new_blueprint_channel` RENAME TO `blueprint_channel`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `blueprint_channel_key` ON `blueprint_channel` (`blueprint_id`,`key`);--> statement-breakpoint
CREATE TABLE `__new_event_staff` (
	`event_id` integer NOT NULL,
	`staff_member_id` integer NOT NULL,
	`role` text NOT NULL,
	`imported` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`event_id`, `staff_member_id`),
	FOREIGN KEY (`event_id`) REFERENCES `event`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`staff_member_id`) REFERENCES `staff_member`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "event_staff_role" CHECK("__new_event_staff"."role" in ('headjudge', 'judge', 'scorekeeper', 'administration', 'translator', 'streaming')),
	CONSTRAINT "event_staff_imported" CHECK("__new_event_staff"."imported" in (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_event_staff`("event_id", "staff_member_id", "role", "imported") SELECT "event_id", "staff_member_id", "role", "imported" FROM `event_staff`;--> statement-breakpoint
DROP TABLE `event_staff`;--> statement-breakpoint
ALTER TABLE `__new_event_staff` RENAME TO `event_staff`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
