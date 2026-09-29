CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	CONSTRAINT `fk_oauth_client_resource_client_id_oauth_client_client_id_fk` FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_oauth_client_resource_resource_id_oauth_resource_identifier_fk` FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY,
	`identifier` text NOT NULL UNIQUE,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
ALTER TABLE `jwks` ADD `alg` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `crv` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `revoked` integer;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `confirmation` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `client_discovery_id` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `client_credentials_scopes` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `backchannel_logout_session_required` integer;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `application_type` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `dpop_bound_access_tokens` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotated_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotation_replay_response` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotation_replay_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauth_access_token_authorization_code_id_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_resource_client_id_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_resource_resource_id_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_authorization_code_id_idx` ON `oauth_refresh_token` (`authorization_code_id`);