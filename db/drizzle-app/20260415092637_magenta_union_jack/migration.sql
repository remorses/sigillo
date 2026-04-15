CREATE TABLE `config` (
	`id` text PRIMARY KEY DEFAULT 'singleton',
	`oauth_client_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
