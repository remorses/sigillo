// BetterAuth configuration for the self-hosted app.
// Uses genericOAuth to authenticate via the sigillo middleman provider.
// Client ID and secret are read from Cloudflare KV (populated by setup.ts
// during first deployment via dynamic client registration).

import { betterAuth } from 'better-auth'
import { genericOAuth } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type * as durable from 'drizzle-orm/durable-sqlite'
import type * as schema from 'db/src/app-schema.ts'

export async function createAuth({
  db,
  env,
}: {
  db: durable.DrizzleSqliteDODatabase<typeof schema, typeof schema.relations>
  env: Env
}) {
  // Read OAuth credentials from KV — populated by setup.ts at first deploy
  const clientId = await env.CONFIG_KV.get('MIDDLEMAN_CLIENT_ID')
  const clientSecret = await env.CONFIG_KV.get('MIDDLEMAN_CLIENT_SECRET')

  if (!clientId || !clientSecret) {
    throw new Error('OAuth credentials not found in KV. Run /api/setup first.')
  }

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(db, { provider: 'sqlite' }),

    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'sigillo',
            clientId,
            clientSecret,
            discoveryUrl: `${env.PROVIDER_URL}/.well-known/openid-configuration`,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
    ],
  })
}
