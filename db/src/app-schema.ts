// Schema for the self-hosted app D1 database.
// Contains BetterAuth core tables for local auth (genericOAuth sessions)
// and the secrets domain tables.

import { defineRelations } from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Integer column that stores epoch milliseconds as a plain number.
// Unlike integer({ mode: 'number' }), this accepts Date objects in toDriver
// so BetterAuth's internal Date params don't crash D1's .bind() which only
// accepts string | number | null | ArrayBuffer. TypeScript type stays `number`.
export const epochMs = sqliteCore.customType<{ data: number; driverParam: number }>({
  dataType() { return 'integer' },
  toDriver(value: unknown): number {
    if (value instanceof Date) return value.getTime()
    return value as number
  },
  fromDriver(value: unknown): number { return value as number },
})

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = sqliteCore.sqliteTable('user', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  email: sqliteCore.text('email').notNull().unique(),
  emailVerified: sqliteCore.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: sqliteCore.text('image'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

export const session = sqliteCore.sqliteTable('session', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: sqliteCore.text('token').notNull().unique(),
  expiresAt: epochMs('expires_at').notNull(),
  ipAddress: sqliteCore.text('ip_address'),
  userAgent: sqliteCore.text('user_agent'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('session_user_id_idx').on(table.userId),
])

export const account = sqliteCore.sqliteTable('account', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: sqliteCore.text('account_id').notNull(),
  providerId: sqliteCore.text('provider_id').notNull(),
  accessToken: sqliteCore.text('access_token'),
  refreshToken: sqliteCore.text('refresh_token'),
  accessTokenExpiresAt: epochMs('access_token_expires_at'),
  refreshTokenExpiresAt: epochMs('refresh_token_expires_at'),
  scope: sqliteCore.text('scope'),
  idToken: sqliteCore.text('id_token'),
  password: sqliteCore.text('password'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('account_user_id_idx').on(table.userId),
])

export const verification = sqliteCore.sqliteTable('verification', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: sqliteCore.text('identifier').notNull(),
  value: sqliteCore.text('value').notNull(),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// ── Org tables ──────────────────────────────────────────────────────

export const org = sqliteCore.sqliteTable('org', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  // Email domain for automatic member join (e.g. 'acme.com').
  // When set, any user with a verified email ending in this domain
  // is automatically added as a member on their next dashboard visit.
  autoJoinDomain: sqliteCore.text('auto_join_domain'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('org_auto_join_domain_idx').on(table.autoJoinDomain),
])

export const orgMember = sqliteCore.sqliteTable('org_member', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: sqliteCore.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  // 'selected' = only projects in member_access (zero rows = no projects).
  // Explicit because deleting a project cascades its member_access rows: when
  // "zero rows" meant "all", deleting a member's last project unlocked all.
  projectAccess: sqliteCore.text('project_access', { enum: ['all', 'selected'] }).notNull().default('all'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('org_member_org_id_idx').on(table.orgId),
  sqliteCore.index('org_member_user_id_idx').on(table.userId),
  sqliteCore.uniqueIndex('org_member_org_id_user_id_unique').on(table.orgId, table.userId),
])

// ── Org invitation table ────────────────────────────────────────────
// Secret invite links: anyone with the link can join the org after login.
// No email column — not tied to a specific user. No status column — just
// delete the row when accepted or expired.

export const orgInvitation = sqliteCore.sqliteTable('org_invitation', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  role: sqliteCore.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  // JSON array of project IDs the invited user will have access to.
  // null = all projects (unrestricted). When set, acceptInviteAction
  // creates memberAccess rows for each listed project.
  projectIds: sqliteCore.text('project_ids'),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('org_invitation_org_id_idx').on(table.orgId),
])

// ── Secrets domain tables ───────────────────────────────────────────
// Doppler-style hierarchy: org → project → environment → secretEvent
// Each project gets default environments: dev, preview, prod
//
// Secrets use event sourcing: the secretEvent table is an append-only log.
// Current secret values are derived by replaying events per (environmentId, name).
// Events are immutable — never update or delete rows in this table.

export const project = sqliteCore.sqliteTable('project', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_org_id_idx').on(table.orgId),
])

export const environment = sqliteCore.sqliteTable('environment', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  slug: sqliteCore.text('slug').notNull(),
  // Free-form note shown in the dashboard and CLI env lists. '' = none.
  description: sqliteCore.text('description').notNull().default(''),
  // Minimum org role required to access secrets in this environment.
  // 'member' = everyone, 'admin' = only admins can read/write secrets.
  // Use this to restrict production environments to admins only.
  accessRole: sqliteCore.text('access_role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('environment_project_id_idx').on(table.projectId),
  sqliteCore.uniqueIndex('environment_project_id_slug_unique').on(table.projectId, table.slug),
])

// Append-only event log for secrets. Each row is an immutable event.
// "set" = create or update a secret value. "delete" = remove the secret.
// Current state is derived by taking the last event per (environmentId, name).
// NEVER update or delete rows in this table — it is the audit trail.
export const secretEvent = sqliteCore.sqliteTable('secret_event', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  environmentId: sqliteCore.text('environment_id').notNull().references(() => environment.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  // "set" = create or update, "delete" = remove
  operation: sqliteCore.text('operation', { enum: ['set', 'delete'] }).notNull(),
  // Encrypted with Web Crypto AES-GCM, stored as base64. Null for delete events.
  valueEncrypted: sqliteCore.text('value_encrypted'),
  // AES-GCM initialization vector, stored as base64. Null for delete events.
  iv: sqliteCore.text('iv'),
  // Who performed the action: userId for session auth, apiTokenId for bearer
  // tokens. SET NULL, never CASCADE: deleting a token or user must not delete
  // the secrets it wrote (cascade used to revert values to older versions).
  // Both null = author was deleted.
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'set null' }),
  apiTokenId: sqliteCore.text('api_token_id').references(() => apiToken.id, { onDelete: 'set null' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('secret_event_env_name_idx').on(table.environmentId, table.name, table.createdAt),
])

// ── API tokens ──────────────────────────────────────────────────────
// Programmatic access tokens scoped to a project. Optional env allowlist
// lives in apiTokenEnvironment (same 0-rows = all pattern as memberAccess).
// The full key is shown once at creation and never stored — only a SHA-256
// hash is persisted. A short prefix (e.g. "sig_abc1...") is kept for display.

export const apiToken = sqliteCore.sqliteTable('api_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  // First 12 chars after the "sig_" prefix, for display (e.g. "sig_a1b2c3d4e5f6...")
  prefix: sqliteCore.text('prefix').notNull(),
  // SHA-256 hex digest of the full key — used for verification lookups
  hashedKey: sqliteCore.text('hashed_key').notNull().unique(),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('api_token_project_id_idx').on(table.projectId),
  sqliteCore.index('api_token_hashed_key_idx').on(table.hashedKey),
])

// Env allowlist for a token. Zero rows = all envs in the project.
// One or more rows = only those envs. Migration 0007 adds a trigger that
// revokes the token when its last row is deleted, so cascade cannot widen
// a scoped token to all. D1 keeps foreign_keys ON (PRAGMA foreign_keys=OFF
// is ignored), so any DROP TABLE of a parent fires child ON DELETE actions.
export const apiTokenEnvironment = sqliteCore.sqliteTable('api_token_environment', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  tokenId: sqliteCore.text('token_id').notNull().references(() => apiToken.id, { onDelete: 'cascade' }),
  environmentId: sqliteCore.text('environment_id').notNull().references(() => environment.id, { onDelete: 'cascade' }),
}, (table) => [
  sqliteCore.uniqueIndex('api_token_environment_token_env_unique').on(table.tokenId, table.environmentId),
  sqliteCore.index('api_token_environment_token_id_idx').on(table.tokenId),
  sqliteCore.index('api_token_environment_environment_id_idx').on(table.environmentId),
])

// ── Member access (project-level permissions) ──────────────────────
// Projects a member with orgMember.projectAccess = 'selected' can access.
// Ignored for projectAccess = 'all' and for admins.

export const memberAccess = sqliteCore.sqliteTable('member_access', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgMemberId: sqliteCore.text('org_member_id').notNull()
    .references(() => orgMember.id, { onDelete: 'cascade' }),
  projectId: sqliteCore.text('project_id').notNull()
    .references(() => project.id, { onDelete: 'cascade' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.uniqueIndex('member_access_member_project_unique')
    .on(table.orgMemberId, table.projectId),
  sqliteCore.index('member_access_org_member_id_idx').on(table.orgMemberId),
  sqliteCore.index('member_access_project_id_idx').on(table.projectId),
])

// Default environments created for every new project
export const DEFAULT_ENVIRONMENTS = [
  { name: 'Dev', slug: 'dev' },
  { name: 'Preview', slug: 'preview' },
  { name: 'Prod', slug: 'prod' },
] as const

// ── oauthDomain table ────────────────────────────────────────────────
// Stores the provider client registration for each app hostname.
export const oauthDomain = sqliteCore.sqliteTable('oauth_domain', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  host: sqliteCore.text('host').notNull().unique(),
  oauthClientId: sqliteCore.text('oauth_client_id').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').notNull().$defaultFn(() => Date.now()),
})

// ── deviceCode table (device authorization plugin, RFC 8628) ────────
// Stores pending device codes for CLI/agent login flows.
// Agents call /api/auth/device/code to get a code, user enters it at /device.

export const deviceCode = sqliteCore.sqliteTable('device_code', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  deviceCode: sqliteCore.text('device_code').notNull().unique(),
  userCode: sqliteCore.text('user_code').notNull().unique(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: epochMs('expires_at').notNull(),
  status: sqliteCore.text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  lastPolledAt: epochMs('last_polled_at'),
  pollingInterval: sqliteCore.integer('polling_interval', { mode: 'number' }),
  clientId: sqliteCore.text('client_id'),
  scope: sqliteCore.text('scope'),
}, (table) => [
  sqliteCore.index('device_code_user_id_idx').on(table.userId),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, org, orgMember, orgInvitation, project, environment, secretEvent, apiToken, apiTokenEnvironment, deviceCode, oauthDomain, memberAccess },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      orgs: r.many.org({
        from: r.user.id.through(r.orgMember.userId),
        to: r.org.id.through(r.orgMember.orgId),
      }),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    org: {
      members: r.many.orgMember(),
      invitations: r.many.orgInvitation(),
      projects: r.many.project(),
      users: r.many.user({
        from: r.org.id.through(r.orgMember.orgId),
        to: r.user.id.through(r.orgMember.userId),
      }),
    },
    orgMember: {
      org: r.one.org({ from: r.orgMember.orgId, to: r.org.id }),
      user: r.one.user({ from: r.orgMember.userId, to: r.user.id }),
      accessRules: r.many.memberAccess(),
    },
    orgInvitation: {
      org: r.one.org({ from: r.orgInvitation.orgId, to: r.org.id }),
      creator: r.one.user({ from: r.orgInvitation.createdBy, to: r.user.id }),
    },
    project: {
      org: r.one.org({ from: r.project.orgId, to: r.org.id }),
      environments: r.many.environment(),
      apiTokens: r.many.apiToken(),
    },
    environment: {
      project: r.one.project({ from: r.environment.projectId, to: r.project.id }),
      secretEvents: r.many.secretEvent(),
      apiTokenEnvironments: r.many.apiTokenEnvironment(),
    },
    secretEvent: {
      environment: r.one.environment({ from: r.secretEvent.environmentId, to: r.environment.id }),
      user: r.one.user({ from: r.secretEvent.userId, to: r.user.id }),
      apiToken: r.one.apiToken({ from: r.secretEvent.apiTokenId, to: r.apiToken.id }),
    },
    apiToken: {
      project: r.one.project({ from: r.apiToken.projectId, to: r.project.id }),
      creator: r.one.user({ from: r.apiToken.createdBy, to: r.user.id }),
      environments: r.many.apiTokenEnvironment(),
    },
    apiTokenEnvironment: {
      token: r.one.apiToken({ from: r.apiTokenEnvironment.tokenId, to: r.apiToken.id }),
      environment: r.one.environment({ from: r.apiTokenEnvironment.environmentId, to: r.environment.id }),
    },
    deviceCode: {
      user: r.one.user({ from: r.deviceCode.userId, to: r.user.id }),
    },
    memberAccess: {
      orgMember: r.one.orgMember({ from: r.memberAccess.orgMemberId, to: r.orgMember.id }),
      project: r.one.project({ from: r.memberAccess.projectId, to: r.project.id }),
    },
    oauthDomain: {},
  }),
)
