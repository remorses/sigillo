// Schema for the provider Durable Object (middleman OAuth provider).
// BetterAuth core tables (user, session, account, verification) plus
// oauthProvider plugin tables (oauthClient, oauthConsent, oauthToken, etc.)

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

// ── oauthProvider plugin tables ─────────────────────────────────────

export const oauthClient = sqliteCore.sqliteTable('oauth_client', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull().unique(),
  clientSecret: sqliteCore.text('client_secret'),
  clientName: sqliteCore.text('client_name'),
  redirectUris: sqliteCore.text('redirect_uris').notNull(), // JSON array
  grantTypes: sqliteCore.text('grant_types'), // JSON array
  responseTypes: sqliteCore.text('response_types'), // JSON array
  scope: sqliteCore.text('scope'),
  tokenEndpointAuthMethod: sqliteCore.text('token_endpoint_auth_method'),
  skipConsent: sqliteCore.integer('skip_consent', { mode: 'boolean' }).default(false),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: sqliteCore.text('reference_id'),
  metadata: sqliteCore.text('metadata'), // JSON
  clientSecretExpiresAt: sqliteCore.integer('client_secret_expires_at', { mode: 'number' }),
  enableEndSession: sqliteCore.integer('enable_end_session', { mode: 'boolean' }).default(false),
  requirePkce: sqliteCore.integer('require_pkce', { mode: 'boolean' }).default(true),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

export const oauthConsent = sqliteCore.sqliteTable('oauth_consent', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  clientId: sqliteCore.text('client_id').notNull(),
  scope: sqliteCore.text('scope').notNull(),
  referenceId: sqliteCore.text('reference_id'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
  updatedAt: sqliteCore.integer('updated_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('oauth_consent_user_id_idx').on(table.userId),
])

export const oauthToken = sqliteCore.sqliteTable('oauth_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  accessToken: sqliteCore.text('access_token').notNull(),
  refreshToken: sqliteCore.text('refresh_token'),
  accessTokenExpiresAt: sqliteCore.integer('access_token_expires_at', { mode: 'number' }).notNull(),
  refreshTokenExpiresAt: sqliteCore.integer('refresh_token_expires_at', { mode: 'number' }),
  scope: sqliteCore.text('scope'),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('oauth_token_user_id_idx').on(table.userId),
])

export const oauthCode = sqliteCore.sqliteTable('oauth_code', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  code: sqliteCore.text('code').notNull().unique(),
  clientId: sqliteCore.text('client_id').notNull(),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  redirectUri: sqliteCore.text('redirect_uri').notNull(),
  scope: sqliteCore.text('scope'),
  codeChallenge: sqliteCore.text('code_challenge'),
  codeChallengeMethod: sqliteCore.text('code_challenge_method'),
  expiresAt: sqliteCore.integer('expires_at', { mode: 'number' }).notNull(),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
}, (table) => [
  sqliteCore.index('oauth_code_user_id_idx').on(table.userId),
])

// ── jwks table (jwt plugin) ────────────────────────────────────────

export const jwks = sqliteCore.sqliteTable('jwks', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  publicKey: sqliteCore.text('public_key').notNull(),
  privateKey: sqliteCore.text('private_key').notNull(),
  createdAt: sqliteCore.integer('created_at', { mode: 'number' }).notNull().$defaultFn(() => Date.now()),
})

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, oauthClient, oauthConsent, oauthToken, oauthCode, jwks },
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
    oauthToken: {
      user: r.one.user({ from: r.oauthToken.userId, to: r.user.id }),
    },
    oauthCode: {
      user: r.one.user({ from: r.oauthCode.userId, to: r.user.id }),
    },
    verification: {},
    oauthClient: {},
    jwks: {},
  }),
)
