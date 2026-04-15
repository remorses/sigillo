// Spiceflow entry for the middleman OAuth provider.
// BetterAuth runs in the worker (not the DO) — the DO is a thin SQL proxy.
// Serves BetterAuth API, redirects login straight to Google, well-known
// endpoints, and health check.
// Also serves as the Cloudflare Worker entry via the default export.

import { Spiceflow } from 'spiceflow'
import { Head } from 'spiceflow/react'
import { getAuth } from './db.ts'
import { ConsentButtons } from './components/consent-buttons.tsx'

export { AuthStore } from './auth-store.ts'

function getRedirectDomain(redirectUri: string | null) {
  if (!redirectUri) return null
  try {
    return new URL(redirectUri).hostname
  } catch {
    return null
  }
}

export const app = new Spiceflow()

  // ── BetterAuth middleware ──────────────────────────────────────
  // BetterAuth runs in the worker, not the DO. Only SQL crosses the
  // DO boundary via sqlite-proxy.
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const auth = getAuth()
      const res = await auth.handler(request)
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

  // ── Login redirect ─────────────────────────────────────────────
  // BetterAuth oauthProvider redirects here when user is not logged in.
  // Instead of showing a button, redirect straight to Google via the
  // type-safe BetterAuth API — now runs directly in the worker.
  .get('/sign-in', async ({ request }) => {
    const currentUrl = new URL(request.url)
    const auth = getAuth()
    // Use returnHeaders so we get both the redirect URL and the Set-Cookie
    // headers (state cookie for CSRF). A bare Response.redirect() drops
    // those cookies → state_mismatch on the Google callback.
    const { headers: responseHeaders, response } = await auth.api.signInSocial({
      body: { provider: 'google', callbackURL: currentUrl.href },
      headers: request.headers,
      returnHeaders: true,
    })
    if (!response?.url) {
      return new Response('Failed to initiate Google sign-in', { status: 500 })
    }
    const redirect = new Response(null, { status: 302, headers: { Location: response.url } })
    // Forward all Set-Cookie headers from BetterAuth (state cookie for CSRF).
    // getSetCookie() returns each cookie separately — append preserves multiples.
    for (const cookie of responseHeaders.getSetCookie()) {
      redirect.headers.append('Set-Cookie', cookie)
    }
    return redirect
  })

  .page('/consent', async ({ request }) => {
    const url = new URL(request.url)
    const redirectDomain = getRedirectDomain(url.searchParams.get('redirect_uri'))
    const clientId = url.searchParams.get('client_id')

    return (
      <main
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#f8fafc',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 460,
            background: 'white',
            borderRadius: 16,
            padding: 32,
            boxShadow: '0 16px 40px rgba(15, 23, 42, 0.08)',
          }}
        >
          <p style={{ margin: 0, fontSize: 13, color: '#64748b', fontWeight: 600 }}>OAuth consent</p>
          <h1 style={{ margin: '12px 0 0', fontSize: 28, color: '#0f172a' }}>Allow access?</h1>
          <p style={{ margin: '12px 0 0', color: '#334155', lineHeight: 1.6 }}>
            {redirectDomain ? (
              <>
                <strong>{redirectDomain}</strong> wants to use Sigillo Auth to sign you in.
              </>
            ) : (
              'This app wants to use Sigillo Auth to sign you in.'
            )}
          </p>
          {clientId ? (
            <p style={{ margin: '12px 0 0', color: '#64748b', fontSize: 14 }}>
              Client ID: <code>{clientId}</code>
            </p>
          ) : null}
          <p style={{ margin: '20px 0 0', color: '#64748b', fontSize: 14, lineHeight: 1.6 }}>
            Only continue if you trust this domain and expected this sign-in request.
          </p>
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <ConsentButtons />
          </div>
        </div>
      </main>
    )
  })

  // ── Well-known endpoints ─────────────────────────────────────
  // BetterAuth oauthProvider requires these to be exposed as separate
  // routes — they are NOT served by auth.handler() automatically.
  // Issuer path is /api/auth, so:
  //   OIDC:    [issuer-path]/.well-known/openid-configuration
  //   OAuth AS: /.well-known/oauth-authorization-server[issuer-path]
  .get('/api/auth/.well-known/openid-configuration', async () => {
    const auth = getAuth()
    return Response.json(await auth.api.getOpenIdConfig({ headers: new Headers() }))
  })
  .get('/.well-known/oauth-authorization-server/api/auth', async () => {
    const auth = getAuth()
    return Response.json(await auth.api.getOAuthServerConfig({ headers: new Headers() }))
  })
  // Also serve at root for clients that ignore the issuer path
  .get('/.well-known/openid-configuration', async () => {
    const auth = getAuth()
    return Response.json(await auth.api.getOpenIdConfig({ headers: new Headers() }))
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
