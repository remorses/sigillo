// Spiceflow entry for the middleman OAuth provider.
// Renders login + consent pages, serves BetterAuth API, health check.
// Also serves as the Cloudflare Worker entry via the default export.

import { Spiceflow } from 'spiceflow'
import { Head, Link } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import type { AuthStore } from './auth-store.ts'
import { GoogleSignInButton } from './components/google-sign-in-button.tsx'

export { AuthStore } from './auth-store.ts'

function getAuthStoreStub() {
  const id = env.AUTH_STORE.idFromName('main')
  return env.AUTH_STORE.get(id) as DurableObjectStub<AuthStore>
}

export const app = new Spiceflow()

  // ── BetterAuth middleware ──────────────────────────────────────
  // Forward /api/auth/* requests to the DO's BetterAuth handler.
  // Falls through to spiceflow routes on 404 so we can register our own
  // routes under /api/auth/* (e.g. .well-known, custom endpoints).
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getAuthStoreStub()
      const res = await stub.authHandler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  // ── Root layout ───────────────────────────────────────────────
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Sigillo Auth</Head.Title>
        </Head>
        <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: 0 }}>
          {children}
        </body>
      </html>
    )
  })

  // ── Login page ────────────────────────────────────────────────
  // BetterAuth oauthProvider redirects here when user is not logged in.
  // User clicks "Sign in with Google" which hits BetterAuth's Google social endpoint.
  .page('/sign-in', async () => {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <h1>Sigillo</h1>
          <p>Sign in to continue</p>
          <GoogleSignInButton />
        </div>
      </div>
    )
  })

  // ── Well-known endpoints ─────────────────────────────────────
  // BetterAuth oauthProvider requires these to be exposed as separate
  // routes — they are NOT served by auth.handler() automatically.
  // Issuer path is /api/auth, so:
  //   OIDC:    [issuer-path]/.well-known/openid-configuration
  //   OAuth AS: /.well-known/oauth-authorization-server[issuer-path]
  .get('/api/auth/.well-known/openid-configuration', async () => {
    const stub = getAuthStoreStub()
    return Response.json(await stub.getOpenIdConfig())
  })
  .get('/.well-known/oauth-authorization-server/api/auth', async () => {
    const stub = getAuthStoreStub()
    return Response.json(await stub.getOAuthServerConfig())
  })
  // Also serve at root for clients that ignore the issuer path
  .get('/.well-known/openid-configuration', async () => {
    const stub = getAuthStoreStub()
    return Response.json(await stub.getOpenIdConfig())
  })

  // ── Health check ──────────────────────────────────────────────
  .get('/health', () => {
    return { ok: true, service: 'sigillo-provider' }
  })
  .get('/', () => {
    return { ok: true, service: 'sigillo-provider' }
  })

export type App = typeof app

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>


