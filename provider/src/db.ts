// Worker-level database client and BetterAuth instance for the provider.
//
// getDb() creates a drizzle-orm/sqlite-proxy client bound to env.DB.
// Uses sqlite-proxy instead of drizzle-orm/d1 to avoid the batch findFirst
// crash (drizzle-team/drizzle-orm#2721). The schema uses epochMs custom
// columns that accept both Date and number inputs, so BetterAuth's Date
// params are converted to epoch ms before reaching D1.
// getAuth() creates a BetterAuth instance backed by the same drizzle client
// with oauthProvider + jwt + Google social.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema.ts'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'

// ── Drizzle client via D1 ───────────────────────────────────────────

function d1ToRawRows(results: Record<string, unknown>[]) {
  return results.map((row) => Object.keys(row).map((k) => row[k]))
}

export function getDb() {
  return drizzle(
    async (sql, params, method) => {
      const stmt = env.DB.prepare(sql).bind(...params)
      if (method === 'run') { await stmt.run(); return { rows: [] as any[] } }
      const rows = await stmt.raw()
      if (method === 'get') return { rows: rows[0] as any }
      return { rows: rows as any[] }
    },
    async (queries) => {
      const stmts = queries.map((q) => env.DB.prepare(q.sql).bind(...q.params))
      const results = await env.DB.batch(stmts)
      return results.map((r, i) => {
        const rows = d1ToRawRows(r.results as Record<string, unknown>[])
        if (queries[i]!.method === 'get') return { rows: rows[0] as any }
        return { rows: rows as any[] }
      })
    },
    { schema, relations: schema.relations },
  )
}

// ── BetterAuth ──────────────────────────────────────────────────────

export function getAuth() {
  const db = getDb()
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes — avoids a D1 round-trip on every request
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: 'select_account',
      },
    },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: '/sign-in',
        // Dynamic client registration stays open for self-hosted instances,
        // but clients are no longer treated as trusted by default.
        consentPage: '/consent',
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: ['openid', 'email', 'profile', 'offline_access'],
        clientRegistrationDefaultScopes: ['openid', 'email', 'profile'],
      }),
    ],
  })
}
