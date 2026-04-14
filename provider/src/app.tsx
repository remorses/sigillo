// Spiceflow entry for the middleman OAuth provider.
// Renders login + consent pages, serves BetterAuth API, health check.
// Also serves as the Cloudflare Worker entry via the default export.

import { Spiceflow } from 'spiceflow'
import { Head, Link } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import type { AuthStore } from './auth-store.ts'

export { AuthStore } from './auth-store.ts'

function getAuthStoreStub() {
  const id = env.AUTH_STORE.idFromName('main')
  return env.AUTH_STORE.get(id) as DurableObjectStub<AuthStore>
}

export const app = new Spiceflow()

  // ── BetterAuth middleware ──────────────────────────────────────
  // Forward /api/auth/* requests to the DO's BetterAuth handler.
  // This replaces the custom fetch handler — all routing goes through spiceflow.
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getAuthStoreStub()
      return stub.authHandler(request)
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
          <a
            href="/api/auth/sign-in/social?provider=google&callbackURL=/sign-in"
            style={{
              display: 'inline-block',
              padding: '12px 24px',
              background: '#4285f4',
              color: 'white',
              borderRadius: 8,
              textDecoration: 'none',
              fontWeight: 600,
            }}
          >
            Sign in with Google
          </a>
        </div>
      </div>
    )
  })

  // ── Consent page ──────────────────────────────────────────────
  // BetterAuth oauthProvider redirects here for user consent.
  // client_id and scope are passed as query params.
  .page('/consent', async () => {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <h1>Authorize Application</h1>
          <p>An application is requesting access to your account.</p>
          <p style={{ color: '#666', fontSize: 14 }}>
            This will share your email address and profile information.
          </p>
          {/* The consent form is handled by BetterAuth's oauthProviderClient on the client side */}
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24 }}>
            <ConsentButtons />
          </div>
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

// ── Client component for consent buttons ────────────────────────
// This will be extracted to a separate 'use client' file later
function ConsentButtons() {
  return (
    <>
      <form method="POST" action="/api/auth/oauth2/consent" style={{ display: 'inline' }}>
        <input type="hidden" name="accept" value="true" />
        <button
          type="submit"
          style={{
            padding: '10px 20px',
            background: '#22c55e',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Allow
        </button>
      </form>
      <form method="POST" action="/api/auth/oauth2/consent" style={{ display: 'inline' }}>
        <input type="hidden" name="accept" value="false" />
        <button
          type="submit"
          style={{
            padding: '10px 20px',
            background: '#ef4444',
            color: 'white',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Deny
        </button>
      </form>
    </>
  )
}
