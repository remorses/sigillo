// Worker-level database client and BetterAuth instance for the provider.
// Uses D1 directly — no Durable Object proxy layer.
//
// getDb() creates a drizzle-orm/d1 client bound to env.DB.
// getAuth() creates a BetterAuth instance backed by the same drizzle client
// with oauthProvider + jwt + Google social.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema.ts'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { oauthProvider } from '@better-auth/oauth-provider'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'

// ── Drizzle client via D1 ───────────────────────────────────────────

type D1BindValue = string | number | ArrayBuffer | ArrayBufferView | null | Date

// D1 only accepts string | number | null | ArrayBuffer as bound params.
// BetterAuth passes Date objects for timestamp columns. Wrap the D1
// binding to auto-convert Date→epoch ms before they reach D1.

function wrapD1(d1: D1Database): D1Database {
  return new Proxy(d1, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql)
          return new Proxy(stmt, {
            get(s, p, r) {
              if (p === 'bind') {
                return (...params: D1BindValue[]) => {
                  const fixed = params.map((v) => (v instanceof Date ? v.getTime() : v))
                  return s.bind(...fixed)
                }
              }
              const val = Reflect.get(s, p, r)
              return typeof val === 'function' ? val.bind(s) : val
            },
          })
        }
      }
      const val = Reflect.get(target, prop, receiver)
      return typeof val === 'function' ? val.bind(target) : val
    },
  })
}

export function getDb() {
  return drizzle(wrapD1(env.DB), { schema, relations: schema.relations })
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
