DROP TABLE `secret`;
--> statement-breakpoint
CREATE TABLE `secret_event` (
	`id` text PRIMARY KEY,
	`environment_id` text NOT NULL,
	`name` text NOT NULL,
	`operation` text NOT NULL,
	`value_encrypted` text,
	`iv` text,
	`user_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_secret_event_environment_id_environment_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_secret_event_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `secret_event_env_name_idx` ON `secret_event` (`environment_id`, `name`, `created_at`);
