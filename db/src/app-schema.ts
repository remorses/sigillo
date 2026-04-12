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

// ── Secrets domain tables ───────────────────────────────────────────

export const project = sqliteCore.sqliteTable('project', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  name: sqliteCore.text('name').notNull(),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_created_by_idx').on(table.createdBy),
])

export const projectMember = sqliteCore.sqliteTable('project_member', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  role: sqliteCore.text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('project_member_project_id_idx').on(table.projectId),
  sqliteCore.index('project_member_user_id_idx').on(table.userId),
])

export const secret = sqliteCore.sqliteTable('secret', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  projectId: sqliteCore.text('project_id').notNull().references(() => project.id, { onDelete: 'cascade' }),
  name: sqliteCore.text('name').notNull(),
  // Encrypted with Web Crypto AES-GCM, stored as base64
  valueEncrypted: sqliteCore.text('value_encrypted').notNull(),
  // AES-GCM initialization vector, stored as base64
  iv: sqliteCore.text('iv').notNull(),
  createdBy: sqliteCore.text('created_by').notNull().references(() => user.id, { onDelete: 'cascade' }),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('secret_project_id_idx').on(table.projectId),
])

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, project, projectMember, secret },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      projects: r.many.project(),
      memberships: r.many.projectMember(),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    verification: {},
    project: {
      creator: r.one.user({ from: r.project.createdBy, to: r.user.id }),
      members: r.many.projectMember(),
      secrets: r.many.secret(),
    },
    projectMember: {
      project: r.one.project({ from: r.projectMember.projectId, to: r.project.id }),
      user: r.one.user({ from: r.projectMember.userId, to: r.user.id }),
    },
    secret: {
      project: r.one.project({ from: r.secret.projectId, to: r.project.id }),
      creator: r.one.user({ from: r.secret.createdBy, to: r.user.id }),
    },
  }),
)
