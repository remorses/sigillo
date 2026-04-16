DROP TABLE `config`;
--> statement-breakpoint
CREATE TABLE `oauth_domain` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_domain_host_unique` ON `oauth_domain` (`host`);
