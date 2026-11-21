CREATE TABLE `approval_item` (
	`id` text PRIMARY KEY,
	`request_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`secret_name` text DEFAULT '' NOT NULL,
	CONSTRAINT `fk_approval_item_request_id_approval_request_id_fk` FOREIGN KEY (`request_id`) REFERENCES `approval_request`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_approval_item_environment_id_environment_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `approval_request` (
	`id` text PRIMARY KEY,
	`user_id` text,
	`session_id` text,
	`api_token_id` text,
	`label` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`last_used_at` integer,
	`expiry` text DEFAULT 'idle' NOT NULL,
	`grant_expires_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_approval_request_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_approval_request_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_approval_request_api_token_id_api_token_id_fk` FOREIGN KEY (`api_token_id`) REFERENCES `api_token`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_approval_request_approved_by_user_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL UNIQUE,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`rp_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_passkey_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `secret_approval` (
	`id` text PRIMARY KEY,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_secret_approval_environment_id_environment_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_secret_approval_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `environment` ADD `read_approval` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `kind` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `approval_item_request_env_name_unique` ON `approval_item` (`request_id`,`environment_id`,`secret_name`);--> statement-breakpoint
CREATE INDEX `approval_item_environment_id_idx` ON `approval_item` (`environment_id`);--> statement-breakpoint
CREATE INDEX `approval_request_session_id_idx` ON `approval_request` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `approval_request_api_token_id_idx` ON `approval_request` (`api_token_id`,`status`);--> statement-breakpoint
CREATE INDEX `approval_request_user_id_idx` ON `approval_request` (`user_id`);--> statement-breakpoint
CREATE INDEX `passkey_user_id_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `secret_approval_env_name_unique` ON `secret_approval` (`environment_id`,`name`);--> statement-breakpoint
-- Sessions created by the CLI device flow before this migration. The Zig
-- std.http client sends "zig/<version> (std.http)". New ones are marked by
-- the session.create hook in app/src/db.ts.
UPDATE `session` SET `kind` = 'cli' WHERE `user_agent` LIKE 'zig/%(std.http)';
