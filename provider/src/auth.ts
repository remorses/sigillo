// BetterAuth configuration for the middleman OAuth provider.
// - oauthProvider plugin: exposes OAuth 2.1 / OIDC endpoints
// - jwt plugin: signs tokens for oauthProvider
// - Google social provider: the only login method
// - Dynamic client registration: self-hosted apps register programmatically
//
// The database is a drizzle DO SQLite instance passed at request time,
// so we export a factory function rather than a singleton.

import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type * as durable from 'drizzle-orm/durable-sqlite'
import type * as schema from 'db/src/provider-schema.ts'
import {} from 'cloudflare:workers'

export function createAuth({
  db,
  env,
}: {
  db: durable.DrizzleSqliteDODatabase<typeof schema, typeof schema.relations>
  env: Env
}) {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, { provider: 'sqlite' }),

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    plugins: [
      jwt(),

      oauthProvider({
        loginPage: '/sign-in',
        consentPage: '/consent',

        // Dynamic client registration (RFC 7591) — self-hosted apps call this
        allowDynamicClientRegistration: true,
        // Allow unauthenticated registration so deploy-time setup works
        allowUnauthenticatedClientRegistration: true,

        scopes: ['openid', 'email', 'profile', 'offline_access'],
        clientRegistrationDefaultScopes: ['openid', 'email', 'profile'],
      }),
    ],
  })
}
