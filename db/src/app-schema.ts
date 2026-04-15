// Schema for the self-hosted app Durable Object.
// Contains BetterAuth core tables for local auth (genericOAuth sessions)
// and the secrets domain tables.

import { defineRelations } from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// ── BetterAuth core tables ──────────────────────────────────────────

export const user = sqliteCore.sqliteTable('user', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  email: sqliteCore.text('email').notNull().unique(),
  emailVerified: sqliteCore.integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: sqliteCore.text('image'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

export const session = sqliteCore.sqliteTable('session', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: sqliteCore.text('token').notNull().unique(),
  expiresAt: sqliteCore.integer('expires_at', { mode: 'number' }).notNull(),
  ipAddress: sqliteCore.text('ip_address'),
  userAgent: sqliteCore.text('user_agent'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
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
  accessTokenExpiresAt: sqliteCore.integer('access_token_expires_at', { mode: 'number' }),
  refreshTokenExpiresAt: sqliteCore.integer('refresh_token_expires_at', { mode: 'number' }),
  scope: sqliteCore.text('scope'),
  idToken: sqliteCore.text('id_token'),
  password: sqliteCore.text('password'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('account_user_id_idx').on(table.userId),
])

export const verification = sqliteCore.sqliteTable('verification', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: sqliteCore.text('identifier').notNull(),
  value: sqliteCore.text('value').notNull(),
  expiresAt: sqliteCore.integer('expires_at', { mode: 'number' }).notNull(),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

// ── Org tables ──────────────────────────────────────────────────────

export const org = sqliteCore.sqliteTable('org', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

export const orgMember = sqliteCore.sqliteTable('org_member', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: sqliteCore.text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('org_member_org_id_idx').on(table.orgId),
  sqliteCore.index('org_member_user_id_idx').on(table.userId),
])

// ── Secrets domain tables ───────────────────────────────────────────
// Doppler-style hierarchy: org → project → environment → secret
// Each project gets default environments: development, preview, production

export const project = sqliteCore.sqliteTable('project', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  orgId: sqliteCore.text('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_org_id_idx').on(table.orgId),
])

export const environment = sqliteCore.sqliteTable('environment', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  slug: sqliteCore.text('slug').notNull(),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('environment_project_id_idx').on(table.projectId),
])

export const secret = sqliteCore.sqliteTable('secret', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  environmentId: sqliteCore.text('environment_id').notNull().references(() => environment.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  // Encrypted with Web Crypto AES-GCM, stored as base64
  valueEncrypted: sqliteCore.text('value_encrypted').notNull(),
  // AES-GCM initialization vector, stored as base64
  iv: sqliteCore.text('iv').notNull(),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('secret_environment_id_idx').on(table.environmentId),
])

// Default environments created for every new project
export const DEFAULT_ENVIRONMENTS = [
  { name: 'Development', slug: 'development' },
  { name: 'Preview', slug: 'preview' },
  { name: 'Production', slug: 'production' },
] as const

// ── Instance config ─────────────────────────────────────────────────
// Single-row table for instance-level configuration.
// The app auto-registers with the provider on first request and stores
// the OAuth client_id here instead of requiring it as an env var.

export const config = sqliteCore.sqliteTable('config', {
  id: sqliteCore.text('id').primaryKey().notNull().default('singleton'),
  oauthClientId: sqliteCore.text('oauth_client_id'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

// ── deviceCode table (device authorization plugin, RFC 8628) ────────
// Stores pending device codes for CLI/agent login flows.
// Agents call /api/auth/device/code to get a code, user enters it at /device.

export const deviceCode = sqliteCore.sqliteTable('device_code', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  deviceCode: sqliteCore.text('device_code').notNull().unique(),
  userCode: sqliteCore.text('user_code').notNull().unique(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  expiresAt: sqliteCore.integer('expires_at', { mode: 'number' }).notNull(),
  status: sqliteCore.text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull().default('pending'),
  lastPolledAt: sqliteCore.integer('last_polled_at', { mode: 'number' }),
  pollingInterval: sqliteCore.integer('polling_interval', { mode: 'number' }),
  clientId: sqliteCore.text('client_id'),
  scope: sqliteCore.text('scope'),
}, (table) => [
  sqliteCore.index('device_code_user_id_idx').on(table.userId),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, org, orgMember, project, environment, secret, deviceCode, config },
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
      projects: r.many.project(),
      users: r.many.user({
        from: r.org.id.through(r.orgMember.orgId),
        to: r.user.id.through(r.orgMember.userId),
      }),
    },
    orgMember: {
      org: r.one.org({ from: r.orgMember.orgId, to: r.org.id }),
      user: r.one.user({ from: r.orgMember.userId, to: r.user.id }),
    },
    project: {
      org: r.one.org({ from: r.project.orgId, to: r.org.id }),
      environments: r.many.environment(),
    },
    environment: {
      project: r.one.project({ from: r.environment.projectId, to: r.project.id }),
      secrets: r.many.secret(),
    },
    secret: {
      environment: r.one.environment({ from: r.secret.environmentId, to: r.environment.id }),
      creator: r.one.user({ from: r.secret.createdBy, to: r.user.id }),
    },
    deviceCode: {
      user: r.one.user({ from: r.deviceCode.userId, to: r.user.id }),
    },
    config: {},
  }),
)
