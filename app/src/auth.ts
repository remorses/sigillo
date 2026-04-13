// BetterAuth configuration for the self-hosted app.
// Uses genericOAuth to authenticate via the sigillo middleman provider.
// Client ID is read from the config table in SQLite (populated by setup.ts
// during first deployment via dynamic client registration).
//
// This is a PUBLIC OAuth client — no client_secret. Security relies on
// PKCE (Proof Key for Code Exchange) to prevent authorization code interception.

import { eq } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { genericOAuth } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type * as durable from 'drizzle-orm/durable-sqlite'
import * as schema from 'db/src/app-schema.ts'

export function createAuth({
  db,
  env,
}: {
  db: durable.DrizzleSqliteDODatabase<typeof schema, typeof schema.relations>
  env: Env
}) {
  // Read client_id from config table — populated by setup.ts at first deploy
  const row = db.select().from(schema.config).where(eq(schema.config.key, 'middleman_client_id')).get()

  if (!row) {
    throw new Error('OAuth client_id not found in config table. Run /api/setup first.')
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, { provider: 'sqlite' }),

    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'sigillo',
            clientId: row.value,
            // Public client — no clientSecret. PKCE provides security.
            clientSecret: '',
            discoveryUrl: `${env.PROVIDER_URL}/.well-known/openid-configuration`,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
    ],
  })
}
