// Schema for the provider Durable Object (middleman OAuth provider).
// BetterAuth core tables (user, session, account, verification) plus
// oauthProvider plugin tables (oauthClient, oauthConsent, oauthResource,
// oauthClientResource, oauthClientAssertion, oauthAccessToken,
// oauthRefreshToken) and jwt plugin table (jwks).
//
// Field names and types match @better-auth/oauth-provider@1.7.28 exactly.
//
// IMPORTANT: every field BetterAuth types as `string[]` or `json` MUST be
// declared here as `text(name, { mode: 'json' })`, never a plain `text()`.
// `better-auth-drizzle-adapter` hardcodes `supportsArrays: true`, so the
// adapter passes raw JS arrays straight through to drizzle and expects
// drizzle's json mode to serialize them. With a plain text column that
// contract breaks in both directions and the failures look unrelated:
//
//   insert -> D1_TYPE_ERROR: Type 'object' not supported for value '...'
//   select -> TypeError: registered.find is not a function
//             (in findRegisteredRedirectUri, because redirectUris is a
//              raw JSON string instead of an array -> /oauth2/authorize 500s
//              and every login dies at the provider)
//
// The json-mode columns are the SAME on-disk representation (TEXT holding
// JSON), so switching a column to `{ mode: 'json' }` needs no migration.
//
// Use jsonArray() below for `string[]` fields so the TS type stays string[].

import { defineRelations } from 'drizzle-orm'
import * as sqliteCore from 'drizzle-orm/sqlite-core'
import { ulid } from 'ulid'

// Better Auth date field: INTEGER ms on disk, Date in JS. Better Auth rejects
// the session cookie cache when its dates are numbers.
const authDate = (name: string) => sqliteCore.integer(name, { mode: 'timestamp_ms' })

// TEXT column holding a JSON-encoded string array. Drizzle handles the
// JSON.parse/stringify, which is what better-auth-drizzle-adapter expects
// for every field BetterAuth types as `string[]`.
const jsonArray = (name: string) => sqliteCore.text(name, { mode: 'json' }).$type<string[]>()

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

// ── oauthProvider plugin tables ─────────────────────────────────────
// string[] and json fields use drizzle json mode (see the note at the top).

export const oauthClient = sqliteCore.sqliteTable('oauth_client', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull().unique(),
  clientSecret: sqliteCore.text('client_secret'),
  clientDiscoveryId: sqliteCore.text('client_discovery_id'),
  name: sqliteCore.text('name'),
  uri: sqliteCore.text('uri'),
  icon: sqliteCore.text('icon'),
  contacts: jsonArray('contacts'),
  tos: sqliteCore.text('tos'),
  policy: sqliteCore.text('policy'),
  softwareId: sqliteCore.text('software_id'),
  softwareVersion: sqliteCore.text('software_version'),
  softwareStatement: sqliteCore.text('software_statement'),
  jwks: sqliteCore.text('jwks'),
  jwksUri: sqliteCore.text('jwks_uri'),
  redirectUris: jsonArray('redirect_uris').notNull(),
  postLogoutRedirectUris: jsonArray('post_logout_redirect_uris'),
  backchannelLogoutUri: sqliteCore.text('backchannel_logout_uri'),
  backchannelLogoutSessionRequired: sqliteCore.integer('backchannel_logout_session_required', { mode: 'boolean' }),
  tokenEndpointAuthMethod: sqliteCore.text('token_endpoint_auth_method'),
  applicationType: sqliteCore.text('application_type'),
  grantTypes: jsonArray('grant_types'),
  responseTypes: jsonArray('response_types'),
  scopes: jsonArray('scopes'),
  clientCredentialsScopes: jsonArray('client_credentials_scopes').default([]),
  // TODO: drop `type` and `public` in the next migration. 1.7 no longer reads
  // them, but the worker that runs while this migration deploys still does.
  type: sqliteCore.text('type'),
  public: sqliteCore.integer('public', { mode: 'boolean' }),
  disabled: sqliteCore.integer('disabled', { mode: 'boolean' }).default(false),
  skipConsent: sqliteCore.integer('skip_consent', { mode: 'boolean' }).default(false),
  enableEndSession: sqliteCore.integer('enable_end_session', { mode: 'boolean' }),
  subjectType: sqliteCore.text('subject_type'),
  requirePKCE: sqliteCore.integer('require_pkce', { mode: 'boolean' }),
  dpopBoundAccessTokens: sqliteCore.integer('dpop_bound_access_tokens', { mode: 'boolean' }).default(false),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: sqliteCore.text('reference_id'),
  metadata: sqliteCore.text('metadata', { mode: 'json' }),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').$defaultFn(() => new Date()),
})

export const oauthConsent = sqliteCore.sqliteTable('oauth_consent', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull(),
  userId: sqliteCore.text('user_id').references(() => user.id, { onDelete: 'cascade' }),
  referenceId: sqliteCore.text('reference_id'),
  scopes: jsonArray('scopes').notNull(),
  resources: jsonArray('resources'),
  requestedUserInfoClaims: jsonArray('requested_user_info_claims'),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').$defaultFn(() => new Date()),
}, (table) => [
  sqliteCore.index('oauth_consent_user_id_idx').on(table.userId),
])

// Protected resources (RFC 8707). Unused by Sigillo, but the plugin reads them.
export const oauthResource = sqliteCore.sqliteTable('oauth_resource', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  identifier: sqliteCore.text('identifier').notNull().unique(),
  name: sqliteCore.text('name').notNull(),
  accessTokenTtl: sqliteCore.integer('access_token_ttl'),
  refreshTokenTtl: sqliteCore.integer('refresh_token_ttl'),
  signingAlgorithm: sqliteCore.text('signing_algorithm'),
  signingKeyId: sqliteCore.text('signing_key_id'),
  allowedScopes: jsonArray('allowed_scopes'),
  customClaims: sqliteCore.text('custom_claims', { mode: 'json' }),
  dpopBoundAccessTokensRequired: sqliteCore.integer('dpop_bound_access_tokens_required', { mode: 'boolean' }).default(false),
  disabled: sqliteCore.integer('disabled', { mode: 'boolean' }).default(false),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
  updatedAt: authDate('updated_at').$defaultFn(() => new Date()),
  policyVersion: sqliteCore.integer('policy_version').default(1),
  metadata: sqliteCore.text('metadata', { mode: 'json' }),
})

export const oauthClientResource = sqliteCore.sqliteTable('oauth_client_resource', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  clientId: sqliteCore.text('client_id').notNull().references(() => oauthClient.clientId, { onDelete: 'cascade' }),
  resourceId: sqliteCore.text('resource_id').notNull().references(() => oauthResource.identifier, { onDelete: 'cascade' }),
  metadata: sqliteCore.text('metadata', { mode: 'json' }),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
}, (table) => [
  sqliteCore.index('oauth_client_resource_resource_id_idx').on(table.resourceId),
  sqliteCore.uniqueIndex('oauth_client_resource_client_id_resource_id_uidx').on(table.clientId, table.resourceId),
])

// Used private_key_jwt client assertions (replay protection). The id is the key.
export const oauthClientAssertion = sqliteCore.sqliteTable('oauth_client_assertion', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  expiresAt: authDate('expires_at').notNull(),
})

export const oauthRefreshToken = sqliteCore.sqliteTable('oauth_refresh_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  token: sqliteCore.text('token').notNull(),
  clientId: sqliteCore.text('client_id').notNull(),
  sessionId: sqliteCore.text('session_id').references(() => session.id, { onDelete: 'set null' }),
  userId: sqliteCore.text('user_id').notNull().references(() => user.id),
  referenceId: sqliteCore.text('reference_id'),
  authorizationCodeId: sqliteCore.text('authorization_code_id'),
  expiresAt: authDate('expires_at').notNull(),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
  revoked: authDate('revoked'),
  rotatedAt: authDate('rotated_at'),
  rotationReplayResponse: sqliteCore.text('rotation_replay_response'),
  rotationReplayExpiresAt: authDate('rotation_replay_expires_at'),
  authTime: authDate('auth_time'),
  confirmation: sqliteCore.text('confirmation', { mode: 'json' }),
  scopes: jsonArray('scopes').notNull(),
  resources: jsonArray('resources'),
  requestedUserInfoClaims: jsonArray('requested_user_info_claims'),
}, (table) => [
  sqliteCore.index('oauth_refresh_token_user_id_idx').on(table.userId),
  sqliteCore.index('oauth_refresh_token_authorization_code_id_idx').on(table.authorizationCodeId),
  // A unique index, not .unique(): drizzle-kit would rebuild the whole table.
  sqliteCore.uniqueIndex('oauth_refresh_token_token_uidx').on(table.token),
])

export const oauthAccessToken = sqliteCore.sqliteTable('oauth_access_token', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  token: sqliteCore.text('token').notNull().unique(),
  clientId: sqliteCore.text('client_id').notNull(),
  sessionId: sqliteCore.text('session_id').references(() => session.id, { onDelete: 'set null' }),
  userId: sqliteCore.text('user_id').references(() => user.id),
  referenceId: sqliteCore.text('reference_id'),
  refreshId: sqliteCore.text('refresh_id').references(() => oauthRefreshToken.id),
  authorizationCodeId: sqliteCore.text('authorization_code_id'),
  expiresAt: authDate('expires_at').notNull(),
  createdAt: authDate('created_at').$defaultFn(() => new Date()),
  revoked: authDate('revoked'),
  confirmation: sqliteCore.text('confirmation', { mode: 'json' }),
  scopes: jsonArray('scopes').notNull(),
  resources: jsonArray('resources'),
  requestedUserInfoClaims: jsonArray('requested_user_info_claims'),
}, (table) => [
  sqliteCore.index('oauth_access_token_user_id_idx').on(table.userId),
  sqliteCore.index('oauth_access_token_authorization_code_id_idx').on(table.authorizationCodeId),
])

// ── jwks table (jwt plugin) ────────────────────────────────────────

export const jwks = sqliteCore.sqliteTable('jwks', {
  id: sqliteCore.text('id').primaryKey().notNull().$defaultFn(() => ulid()),
  publicKey: sqliteCore.text('public_key').notNull(),
  privateKey: sqliteCore.text('private_key').notNull(),
  createdAt: authDate('created_at').notNull().$defaultFn(() => new Date()),
  expiresAt: authDate('expires_at'),
  alg: sqliteCore.text('alg'),
  crv: sqliteCore.text('crv'),
})

// ── Relations (v2 API) ──────────────────────────────────────────────

export const relations = defineRelations(
  { user, session, account, verification, oauthClient, oauthConsent, oauthResource, oauthClientResource, oauthClientAssertion, oauthRefreshToken, oauthAccessToken, jwks },
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
    oauthResource: {},
    oauthClientResource: {},
    oauthClientAssertion: {},
    jwks: {},
  }),
)
