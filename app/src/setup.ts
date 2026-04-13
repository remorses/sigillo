// Dynamic client registration with the sigillo provider (RFC 7591).
// Called once at first deployment via POST /api/setup.
//
// Registers as a PUBLIC client (token_endpoint_auth_method: "none").
// BetterAuth's oauthProvider only allows unauthenticated registration
// for public clients. Security comes from PKCE, not a client_secret.
// Only the client_id is stored in the config table — no secret to leak.

import { eq } from 'drizzle-orm'
import * as schema from 'db/src/app-schema.ts'
import type * as durable from 'drizzle-orm/durable-sqlite'

export async function registerWithProvider({
  db,
  env,
  appUrl,
}: {
  db: durable.DrizzleSqliteDODatabase<typeof schema, typeof schema.relations>
  env: Env
  appUrl: string
}): Promise<{ clientId: string }> {
  // Check if already registered
  const existing = db.select().from(schema.config).where(eq(schema.config.key, 'middleman_client_id')).get()
  if (existing) {
    return { clientId: existing.value }
  }

  const callbackUrl = `${appUrl}/api/auth/oauth2/callback/sigillo`

  const response = await fetch(`${env.PROVIDER_URL}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Sigillo Self-Hosted (${appUrl})`,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile',
      // Public client — no client_secret. Security via PKCE.
      token_endpoint_auth_method: 'none',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to register with provider: ${response.status} ${body}`)
  }

  const client = (await response.json()) as {
    client_id: string
  }

  // Store client_id in config table
  db.insert(schema.config).values({ key: 'middleman_client_id', value: client.client_id }).run()

  return { clientId: client.client_id }
}
