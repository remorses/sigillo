// Register this self-hosted Sigillo instance with the middleman provider
// via RFC 7591 dynamic client registration. Writes OAUTH_CLIENT_ID to .dev.vars.
// Skips if already registered (reads .dev.vars to check).
//
// Runs automatically before `pnpm dev` so local dev always works.
//
// Usage:
//   tsx scripts/register-client.ts                                    # defaults to localhost:8787
//   tsx scripts/register-client.ts --app-url https://secrets.example.com  # custom URL for production

import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(__dirname, '..')
const devVarsPath = resolve(appDir, '.dev.vars')

const { values } = parseArgs({
  options: {
    'app-url': { type: 'string', default: 'http://localhost:8787' },
    'provider-url': { type: 'string', default: 'https://auth.sigillo.dev' },
  },
  strict: true,
})

const appUrl = values['app-url']!
const providerUrl = values['provider-url']!

// Check .dev.vars for existing OAUTH_CLIENT_ID — skip if already registered
if (existsSync(devVarsPath)) {
  const content = readFileSync(devVarsPath, 'utf-8')
  const match = content.match(/^OAUTH_CLIENT_ID=(.+)$/m)
  if (match && match[1]?.trim()) {
    console.log(`Already registered (OAUTH_CLIENT_ID in .dev.vars), skipping.`)
    process.exit(0)
  }
}

const callbackUrl = `${appUrl}/api/auth/oauth2/callback/sigillo`

console.log(`Registering with provider at ${providerUrl}`)
console.log(`App URL: ${appUrl}`)
console.log(`Callback URL: ${callbackUrl}`)

let response: Response
try {
  response = await fetch(`${providerUrl}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Sigillo Self-Hosted (${appUrl})`,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile',
      token_endpoint_auth_method: 'none',
    }),
  })
} catch (err) {
  console.warn(`⚠ Provider unreachable at ${providerUrl} — skipping registration.`)
  console.warn(`  Login won't work until OAUTH_CLIENT_ID is set in .dev.vars`)
  process.exit(0)
}

if (!response.ok) {
  const body = await response.text()
  console.warn(`⚠ Registration failed: ${response.status} ${body}`)
  console.warn(`  Login won't work until OAUTH_CLIENT_ID is set in .dev.vars`)
  process.exit(0)
}

const client = (await response.json()) as { client_id: string }
const clientId = client.client_id

// Write to .dev.vars (append or create)
let content = ''
if (existsSync(devVarsPath)) {
  content = readFileSync(devVarsPath, 'utf-8').trimEnd() + '\n'
}
content += `OAUTH_CLIENT_ID=${clientId}\n`
writeFileSync(devVarsPath, content)

console.log(`Registered! OAUTH_CLIENT_ID=${clientId}`)
console.log(`Written to ${devVarsPath}`)
