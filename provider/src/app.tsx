// Spiceflow entry for the middleman OAuth provider.
// BetterAuth runs in the worker (not the DO) — the DO is a thin SQL proxy.
// Serves BetterAuth API, redirects login straight to Google, well-known
// endpoints, and health check.
// Also serves as the Cloudflare Worker entry via the default export.

import { Spiceflow } from 'spiceflow'
import { Head } from 'spiceflow/react'
import { getAuth } from './db.ts'

export { AuthStore } from './auth-store.ts'

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
