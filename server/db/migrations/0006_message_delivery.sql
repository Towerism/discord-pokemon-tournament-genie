CREATE TABLE `delivered_message` (
	`connection_key` text NOT NULL,
	`message_id` integer NOT NULL,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	`reported_at` integer,
	PRIMARY KEY(`connection_key`, `message_id`),
	CONSTRAINT "delivered_message_outcome" CHECK("delivered_message"."outcome" in ('delivered', 'no_discord_user', 'dm_refused'))
);
--> statement-breakpoint
CREATE INDEX `delivered_message_created` ON `delivered_message` (`created_at`);