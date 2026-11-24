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

// Better Auth date field. Same INTEGER ms on disk as epochMs, but reads back
// as a Date: the session cookie cache is rejected when its dates are numbers.
const authDate = (name: string) => sqliteCore.integer(name, { mode: 'timestamp_ms' })

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = sqliteCore.sqliteTable('user', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  email: sqliteCore.text('email').notNull().unique(),
  emailVerified: sqliteCore.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: sqliteCore.text('image'),
  createdAt: authDate('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').notNull().$defaultFn(() => new Date()),
})

export const session = sqliteCore.sqliteTable('session', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: sqliteCore.text('token').notNull().unique(),
  expiresAt: authDate('expires_at').notNull(),
  ipAddress: sqliteCore.text('ip_address'),
  userAgent: sqliteCore.text('user_agent'),
  // 'cli' = created by the device flow (CLI, agents). A cli session can never
  // enroll the first passkey: its token sits in a file agents can read.
  kind: sqliteCore.text('kind', { enum: ['browser', 'cli'] }).notNull().default('browser'),
  createdAt: authDate('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').notNull().$defaultFn(() => new Date()),
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
  accessTokenExpiresAt: authDate('access_token_expires_at'),
  refreshTokenExpiresAt: authDate('refresh_token_expires_at'),
  scope: sqliteCore.text('scope'),
  idToken: sqliteCore.text('id_token'),
  password: sqliteCore.text('password'),
  createdAt: authDate('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').notNull().$defaultFn(() => new Date()),
}, (table) => [
  sqliteCore.index('account_user_id_idx').on(table.userId),
])

export const verification = sqliteCore.sqliteTable('verification', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: sqliteCore.text('identifier').notNull(),
  value: sqliteCore.text('value').notNull(),
  expiresAt: authDate('expires_at').notNull(),
  createdAt: authDate('created_at').notNull().$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').notNull().$defaultFn(() => new Date()),
})

// ── Org tables ──────────────────────────────────────────────────────

export const org = sqliteCore.sqliteTable('org', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  // Email domain for automatic member join (e.g. 'acme.com').
  // When set, any user with a verified email ending in this domain
  // is automatically added as a member on their next dashboard visit.
  autoJoinDomain: sqliteCore.text('auto_join_domain'),
  // Set once, when the first passkey is trusted for this org. Never cleared:
  // after it, only a trusted passkey can trust another, even if all are gone.
  trustInitializedAt: epochMs('trust_initialized_at'),
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
  // Which secrets need a passkey approval before they are read.
  // 'selected' = only the names in secretApproval, 'all' = every secret.
  readApproval: sqliteCore.text('read_approval', { enum: ['off', 'selected', 'all'] }).notNull().default('off'),
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

// ── Passkey approvals ───────────────────────────────────────────────
// A session or API token needs a human approval, confirmed with a passkey,
// before it reads a protected secret. See docs/passkey-approvals.md.

// WebAuthn credentials of a user. Bound to the host they were created on.
export const passkey = sqliteCore.sqliteTable('passkey', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  // base64url credential id from the authenticator
  credentialId: sqliteCore.text('credential_id').notNull().unique(),
  // base64url COSE public key
  publicKey: sqliteCore.text('public_key').notNull(),
  counter: sqliteCore.integer('counter', { mode: 'number' }).notNull().default(0),
  transports: sqliteCore.text('transports', { mode: 'json' }).$type<string[]>(),
  rpId: sqliteCore.text('rp_id').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
  lastUsedAt: epochMs('last_used_at'),
}, (table) => [
  sqliteCore.index('passkey_user_id_idx').on(table.userId),
])

// A passkey that may confirm actions in one org. Registering a passkey never
// creates a row: the first one is an explicit bootstrap, every later one is
// trusted by an assertion of an already trusted admin passkey.
export const orgPasskey = sqliteCore.sqliteTable('org_passkey', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  passkeyId: sqliteCore.text('passkey_id').notNull().references(() => passkey.id, { onDelete: 'cascade' }),
  // The user whose trusted passkey approved this one. Bootstrap: the owner.
  trustedBy: sqliteCore.text('trusted_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.uniqueIndex('org_passkey_org_id_passkey_id_unique').on(table.orgId, table.passkeyId),
  sqliteCore.index('org_passkey_passkey_id_idx').on(table.passkeyId),
])

// One protected secret name in an environment with readApproval = 'selected'.
export const secretApproval = sqliteCore.sqliteTable('secret_approval', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  environmentId: sqliteCore.text('environment_id').notNull().references(() => environment.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  createdBy: sqliteCore.text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.uniqueIndex('secret_approval_env_name_unique').on(table.environmentId, table.name),
])

// Pending = a request waiting for a human. Approved = the grant. Rows are kept
// after they end, as the audit trail. A credential has at most one pending row.
export const approvalRequest = sqliteCore.sqliteTable('approval_request', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  // Requester: the session user, or the token creator. Used for display.
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'set null' }),
  // The credential the grant is bound to: exactly one of the two is set.
  // SET NULL keeps the audit row; both null = credential deleted, grant dead.
  sessionId: sqliteCore.text('session_id').references(() => session.id, { onDelete: 'set null' }),
  apiTokenId: sqliteCore.text('api_token_id').references(() => apiToken.id, { onDelete: 'set null' }),
  // Why the requester asks. Untrusted text written by an agent.
  label: sqliteCore.text('label').notNull().default(''),
  status: sqliteCore.text('status', { enum: ['pending', 'approved', 'denied', 'revoked'] }).notNull().default('pending'),
  // Pending requests expire here (1h after the last edit).
  expiresAt: epochMs('expires_at').notNull(),
  approvedBy: sqliteCore.text('approved_by').references(() => user.id, { onDelete: 'set null' }),
  approvedAt: epochMs('approved_at'),
  // Set at approval and by protected reads. 'idle' grants end 1h after it.
  lastUsedAt: epochMs('last_used_at'),
  // 'never' = until revoked, only offered for API tokens (CI may be idle for days).
  expiry: sqliteCore.text('expiry', { enum: ['idle', 'never'] }).notNull().default('idle'),
  // Hard stop. Only website unlocks set it (approvedAt + 1 minute).
  grantExpiresAt: epochMs('grant_expires_at'),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('approval_request_session_id_idx').on(table.sessionId, table.status),
  sqliteCore.index('approval_request_api_token_id_idx').on(table.apiTokenId, table.status),
  sqliteCore.index('approval_request_user_id_idx').on(table.userId),
])

export const approvalItem = sqliteCore.sqliteTable('approval_item', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  requestId: sqliteCore.text('request_id').notNull().references(() => approvalRequest.id, { onDelete: 'cascade' }),
  environmentId: sqliteCore.text('environment_id').notNull().references(() => environment.id, { onDelete: 'cascade' }),
  // '' = every secret in the environment
  secretName: sqliteCore.text('secret_name').notNull().default(''),
}, (table) => [
  sqliteCore.uniqueIndex('approval_item_request_env_name_unique').on(table.requestId, table.environmentId, table.secretName),
  sqliteCore.index('approval_item_environment_id_idx').on(table.environmentId),
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
  expiresAt: authDate('expires_at').notNull(),
  status: sqliteCore.text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  lastPolledAt: authDate('last_polled_at'),
  pollingInterval: sqliteCore.integer('polling_interval', { mode: 'number' }),
  clientId: sqliteCore.text('client_id'),
  scope: sqliteCore.text('scope'),
}, (table) => [
  sqliteCore.index('device_code_user_id_idx').on(table.userId),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, org, orgMember, orgInvitation, project, environment, secretEvent, apiToken, apiTokenEnvironment, deviceCode, oauthDomain, memberAccess, passkey, orgPasskey, secretApproval, approvalRequest, approvalItem },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      orgs: r.many.org({
        from: r.user.id.through(r.orgMember.userId),
        to: r.org.id.through(r.orgMember.orgId),
      }),
      passkeys: r.many.passkey(),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
      approvalRequests: r.many.approvalRequest(),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    org: {
      members: r.many.orgMember(),
      invitations: r.many.orgInvitation(),
      projects: r.many.project(),
      trustedPasskeys: r.many.orgPasskey(),
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
      secretApprovals: r.many.secretApproval(),
      approvalItems: r.many.approvalItem(),
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
      approvalRequests: r.many.approvalRequest(),
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
    passkey: {
      user: r.one.user({ from: r.passkey.userId, to: r.user.id }),
      orgTrusts: r.many.orgPasskey(),
    },
    orgPasskey: {
      org: r.one.org({ from: r.orgPasskey.orgId, to: r.org.id }),
      passkey: r.one.passkey({ from: r.orgPasskey.passkeyId, to: r.passkey.id }),
      truster: r.one.user({ from: r.orgPasskey.trustedBy, to: r.user.id, alias: 'orgPasskeyTruster' }),
    },
    secretApproval: {
      environment: r.one.environment({ from: r.secretApproval.environmentId, to: r.environment.id }),
    },
    approvalRequest: {
      user: r.one.user({ from: r.approvalRequest.userId, to: r.user.id, alias: 'approvalRequester' }),
      approver: r.one.user({ from: r.approvalRequest.approvedBy, to: r.user.id, alias: 'approvalApprover' }),
      session: r.one.session({ from: r.approvalRequest.sessionId, to: r.session.id }),
      apiToken: r.one.apiToken({ from: r.approvalRequest.apiTokenId, to: r.apiToken.id }),
      items: r.many.approvalItem(),
    },
    approvalItem: {
      request: r.one.approvalRequest({ from: r.approvalItem.requestId, to: r.approvalRequest.id }),
      environment: r.one.environment({ from: r.approvalItem.environmentId, to: r.environment.id }),
    },
  }),
)
