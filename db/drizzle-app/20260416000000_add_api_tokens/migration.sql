CREATE TABLE `api_token` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`project_id` text NOT NULL,
	`environment_id` text,
	`prefix` text NOT NULL,
	`hashed_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_api_token_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_api_token_environment_id_environment_id_fk` FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_api_token_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_hashed_key_unique` ON `api_token` (`hashed_key`);
--> statement-breakpoint
CREATE INDEX `api_token_project_id_idx` ON `api_token` (`project_id`);
--> statement-breakpoint
CREATE INDEX `api_token_hashed_key_idx` ON `api_token` (`hashed_key`);
