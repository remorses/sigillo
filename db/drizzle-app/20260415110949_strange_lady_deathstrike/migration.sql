CREATE TABLE `org_invitation` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_by` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_invitation_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_invitation_created_by_user_id_fk` FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `org_invitation_org_id_idx` ON `org_invitation` (`org_id`);