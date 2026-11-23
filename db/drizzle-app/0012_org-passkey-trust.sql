CREATE TABLE `org_passkey` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`passkey_id` text NOT NULL,
	`trusted_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_org_passkey_org_id_org_id_fk` FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_passkey_passkey_id_passkey_id_fk` FOREIGN KEY (`passkey_id`) REFERENCES `passkey`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_org_passkey_trusted_by_user_id_fk` FOREIGN KEY (`trusted_by`) REFERENCES `user`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
ALTER TABLE `org` ADD `trust_initialized_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `org_passkey_org_id_passkey_id_unique` ON `org_passkey` (`org_id`,`passkey_id`);--> statement-breakpoint
CREATE INDEX `org_passkey_passkey_id_idx` ON `org_passkey` (`passkey_id`);--> statement-breakpoint
-- Grants approved before org trust existed were confirmed by any passkey of the user, also one an agent enrolled. Revoke them; pending requests stay and need a trusted passkey.
UPDATE `approval_request` SET `status` = 'revoked' WHERE `status` = 'approved';--> statement-breakpoint
-- Orgs that already protect an environment fail closed: they count as initialized with no trusted passkey, so no bootstrap. An operator trusts the first passkey by hand (docs/passkey-approvals.md).
UPDATE `org` SET `trust_initialized_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE `id` IN (SELECT `project`.`org_id` FROM `environment` JOIN `project` ON `project`.`id` = `environment`.`project_id` WHERE `environment`.`read_approval` != 'off');--> statement-breakpoint
-- Invite links and domain auto-join made before access changes needed a passkey.
DELETE FROM `org_invitation` WHERE `org_id` IN (SELECT `id` FROM `org` WHERE `trust_initialized_at` IS NOT NULL);--> statement-breakpoint
UPDATE `org` SET `auto_join_domain` = NULL WHERE `trust_initialized_at` IS NOT NULL;--> statement-breakpoint
-- 0011 defaulted every older session to 'browser', also CLI device logins. Their kind is unknown, so mark all as 'cli'; browser users sign out and in again to add or set up passkeys.
UPDATE `session` SET `kind` = 'cli';
