// Dynamic client registration with the sigillo provider.
// Called once at first deployment via POST /api/setup.
// Registers this self-hosted instance as an OAuth client with the middleman
// and stores the received client_id + client_secret in Cloudflare KV.

export async function registerWithProvider({
  env,
  appUrl,
}: {
  env: Env
  appUrl: string
}): Promise<{ clientId: string; clientSecret: string }> {
  // Check if already registered
  const existingClientId = await env.CONFIG_KV.get('MIDDLEMAN_CLIENT_ID')
  if (existingClientId) {
    return {
      clientId: existingClientId,
      clientSecret: '(already stored)',
    }
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
      token_endpoint_auth_method: 'client_secret_post',
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Failed to register with provider: ${response.status} ${body}`)
  }

  const client = (await response.json()) as {
    client_id: string
    client_secret: string
  }

  // Store credentials in KV — client_secret is only returned once
  await env.CONFIG_KV.put('MIDDLEMAN_CLIENT_ID', client.client_id)
  await env.CONFIG_KV.put('MIDDLEMAN_CLIENT_SECRET', client.client_secret)

  return {
    clientId: client.client_id,
    clientSecret: client.client_secret,
  }
}
