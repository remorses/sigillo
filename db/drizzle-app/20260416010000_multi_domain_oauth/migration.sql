DROP TABLE IF EXISTS `config`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `config` (
	`id` text PRIMARY KEY DEFAULT 'singleton',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `oauth_domain` (
	`id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`oauth_client_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `oauth_domain_host_unique` ON `oauth_domain` (`host`);
