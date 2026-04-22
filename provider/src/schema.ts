// Schema for the provider Durable Object (middleman OAuth provider).
// BetterAuth core tables (user, session, account, verification) plus
// oauthProvider plugin tables (oauthClient, oauthConsent, oauthAccessToken,
// oauthRefreshToken) and jwt plugin table (jwks).
//
// Field names and types match @better-auth/oauth-provider@1.6.3 exactly.
// BetterAuth stores string[] as JSON-encoded text columns.

import { defineRelations } from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Integer column that stores epoch milliseconds as a plain number.
// Unlike integer({ mode: 'number' }), this accepts Date objects in toDriver
// so BetterAuth's internal Date params don't crash D1's .bind() which only
// accepts string | number | null | ArrayBuffer. TypeScript type stays `number`.
const epochMs = sqliteCore.customType<{ data: number; driverParam: number }>({
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

// ── oauthProvider plugin tables ─────────────────────────────────────
// Field names match @better-auth/oauth-provider@1.6.3 schema definition.
// string[] fields are stored as JSON text by BetterAuth's drizzle adapter.

export const oauthClient = sqliteCore.sqliteTable('oauth_client', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull().unique(),
  clientSecret: sqliteCore.text('client_secret'),
  name: sqliteCore.text('name'),
  uri: sqliteCore.text('uri'),
  icon: sqliteCore.text('icon'),
  contacts: sqliteCore.text('contacts'), // JSON string[]
  tos: sqliteCore.text('tos'),
  policy: sqliteCore.text('policy'),
  softwareId: sqliteCore.text('software_id'),
  softwareVersion: sqliteCore.text('software_version'),
  softwareStatement: sqliteCore.text('software_statement'),
  redirectUris: sqliteCore.text('redirect_uris').notNull(), // JSON string[]
  postLogoutRedirectUris: sqliteCore.text('post_logout_redirect_uris'), // JSON string[]
  tokenEndpointAuthMethod: sqliteCore.text('token_endpoint_auth_method'),
  grantTypes: sqliteCore.text('grant_types'), // JSON string[]
  responseTypes: sqliteCore.text('response_types'), // JSON string[]
  scopes: sqliteCore.text('scopes'), // JSON string[]
  type: sqliteCore.text('type'),
  public: sqliteCore.integer('public', { mode: 'boolean' }),
  disabled: sqliteCore.integer('disabled', { mode: 'boolean' }).default(false),
  skipConsent: sqliteCore.integer('skip_consent', { mode: 'boolean' }).default(false),
  enableEndSession: sqliteCore.integer('enable_end_session', { mode: 'boolean' }),
  subjectType: sqliteCore.text('subject_type'),
  requirePKCE: sqliteCore.integer('require_pkce', { mode: 'boolean' }),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: sqliteCore.text('reference_id'),
  metadata: sqliteCore.text('metadata'), // JSON
  createdAt: epochMs('created_at').$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').$defaultFn(() => Date.now()),
})

export const oauthConsent = sqliteCore.sqliteTable('oauth_consent', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: sqliteCore.text('reference_id'),
  scopes: sqliteCore.text('scopes').notNull(), // JSON string[]
  createdAt: epochMs('created_at').$defaultFn(() => Date.now()),
  updatedAt: epochMs('updated_at').$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('oauth_consent_user_id_idx').on(table.userId),
])

export const oauthRefreshToken = sqliteCore.sqliteTable('oauth_refresh_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  token: sqliteCore.text('token').notNull(),
  clientId: sqliteCore.text('client_id').notNull(),
  sessionId: sqliteCore.text('session_id').references(() => session.id, { onDelete: 'set null' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id),
  referenceId: sqliteCore.text('reference_id'),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').$defaultFn(() => Date.now()),
  revoked: epochMs('revoked'),
  authTime: epochMs('auth_time'),
  scopes: sqliteCore.text('scopes').notNull(), // JSON string[]
}, (table) => [
  sqliteCore.index('oauth_refresh_token_user_id_idx').on(table.userId),
])

export const oauthAccessToken = sqliteCore.sqliteTable('oauth_access_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  token: sqliteCore.text('token').notNull().unique(),
  clientId: sqliteCore.text('client_id').notNull(),
  sessionId: sqliteCore.text('session_id').references(() => session.id, { onDelete: 'set null' }),
  userId: sqliteCore.text('user_id').references(() => user.id),
  referenceId: sqliteCore.text('reference_id'),
  refreshId: sqliteCore.text('refresh_id').references(() => oauthRefreshToken.id),
  expiresAt: epochMs('expires_at').notNull(),
  createdAt: epochMs('created_at').$defaultFn(() => Date.now()),
  scopes: sqliteCore.text('scopes').notNull(), // JSON string[]
}, (table) => [
  sqliteCore.index('oauth_access_token_user_id_idx').on(table.userId),
])

// ── jwks table (jwt plugin) ────────────────────────────────────────

export const jwks = sqliteCore.sqliteTable('jwks', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  publicKey: sqliteCore.text('public_key').notNull(),
  privateKey: sqliteCore.text('private_key').notNull(),
  createdAt: epochMs('created_at').notNull().$defaultFn(() => Date.now()),
})

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, oauthClient, oauthConsent, oauthRefreshToken, oauthAccessToken, jwks },
  (r) => ({
    user: {
      sessions: r.many.session(),
      accounts: r.many.account(),
      oauthConsents: r.many.oauthConsent(),
    },
    session: {
      user: r.one.user({ from: r.session.userId, to: r.user.id }),
    },
    account: {
      user: r.one.user({ from: r.account.userId, to: r.user.id }),
    },
    oauthConsent: {
      user: r.one.user({ from: r.oauthConsent.userId, to: r.user.id }),
    },
    oauthRefreshToken: {
      user: r.one.user({ from: r.oauthRefreshToken.userId, to: r.user.id }),
      session: r.one.session({ from: r.oauthRefreshToken.sessionId, to: r.session.id }),
    },
    oauthAccessToken: {
      user: r.one.user({ from: r.oauthAccessToken.userId, to: r.user.id }),
      session: r.one.session({ from: r.oauthAccessToken.sessionId, to: r.session.id }),
      refresh: r.one.oauthRefreshToken({ from: r.oauthAccessToken.refreshId, to: r.oauthRefreshToken.id }),
    },
    verification: {},
    oauthClient: {},
    jwks: {},
  }),
)
