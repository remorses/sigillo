// Spiceflow entry for the middleman OAuth provider.
// BetterAuth runs in the worker (not the DO) — the DO is a thin SQL proxy.
// Serves BetterAuth API, redirects login straight to Google, well-known
// endpoints, and health check.
// Also serves as the Cloudflare Worker entry via the default export.

import './globals.css'

import { Spiceflow } from 'spiceflow'
import { Head } from 'spiceflow/react'
import { getAuth } from './db.ts'
import { ConsentButtons } from './components/consent-buttons.tsx'


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
        <body className="min-h-screen bg-background font-sans text-foreground antialiased">
          {children}
        </body>
      </html>
    )
  })

  // ── Login redirect ─────────────────────────────────────────────
  // BetterAuth oauthProvider redirects here when user is not logged in.
  // Instead of showing a button, redirect straight to Google via the
  // type-safe BetterAuth API — now runs directly in the worker.
  //
  // Important: after Google redirects back here, this route must detect the
  // freshly created provider session and resume the original OAuth authorize
  // request. Otherwise it would immediately start another Google sign-in and
  // loop forever between /sign-in and accounts.google.com.
  .get('/sign-in', async ({ request }) => {
    const currentUrl = new URL(request.url)
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: request.headers })
    if (session) {
      const authorizeUrl = new URL('/api/auth/oauth2/authorize', currentUrl.origin)
      authorizeUrl.search = currentUrl.search
      return Response.redirect(authorizeUrl.toString(), 302)
    }

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

    if (redirectDomain === 'sigillo.dev') {
      const auth = getAuth()
      const result = await auth.api.oauth2Consent({
        body: {
          accept: true,
          oauth_query: url.search.slice(1),
        },
        headers: request.headers,
      })

      return Response.redirect(result.url, 302)
    }

    return (
      <main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-8">
        <div className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-7xl items-center justify-center">
          <div className="grid w-full max-w-5xl gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
            <section className="rounded-[28px] border border-border bg-card p-8 shadow-[0_24px_60px_rgba(15,23,42,0.12)] sm:p-10 dark:shadow-[0_24px_60px_rgba(0,0,0,0.4)]">
              <div className="inline-flex items-center rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                Sigillo Auth
              </div>
              <h1 className="mt-5 text-4xl font-semibold tracking-[-0.03em] text-balance sm:text-5xl">
                Allow access to continue?
              </h1>
              <p className="mt-4 text-base leading-7 text-muted-foreground">
                {redirectDomain ? (
                  <>
                    <span className="font-semibold text-foreground">{redirectDomain}</span> wants to use Sigillo Auth to sign you in.
                  </>
                ) : (
                  'This app wants to use Sigillo Auth to sign you in.'
                )}
              </p>

              <div className="mt-8 rounded-[20px] border border-border bg-card p-5 shadow-sm">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Redirect domain
                </p>
                <p className="mt-3.5 overflow-wrap-anywhere text-2xl font-semibold leading-8 text-foreground">
                  {redirectDomain ?? 'Unknown domain'}
                </p>
                <p className="mt-3.5 text-sm leading-6 text-muted-foreground">
                  Only continue if you expected this sign-in request and trust this domain.
                </p>
              </div>

              <div className="mt-8">
                <ConsentButtons />
              </div>
            </section>

            <aside className="rounded-[28px] border border-border bg-secondary/80 p-8 sm:p-10">
              <div className="rounded-[20px] border border-border bg-card p-5 shadow-sm">
                <p className="text-sm font-semibold text-card-foreground">What you’re approving</p>
                <ul className="mt-4 grid gap-3">
                  <li className="rounded-2xl border border-border bg-card px-4 py-3.5 text-sm leading-6 text-muted-foreground shadow-sm">
                    Use your Sigillo account identity to complete sign-in
                  </li>
                  <li className="rounded-2xl border border-border bg-card px-4 py-3.5 text-sm leading-6 text-muted-foreground shadow-sm">
                    Share the basic profile fields needed for authentication
                  </li>
                  <li className="rounded-2xl border border-border bg-card px-4 py-3.5 text-sm leading-6 text-muted-foreground shadow-sm">
                    Return you to <span className="font-semibold text-foreground">{redirectDomain ?? 'the requesting app'}</span> after approval
                  </li>
                </ul>
              </div>

              <p className="mt-4 text-sm leading-6 text-muted-foreground">
                Sigillo does not show the raw OAuth client identifier here. The only thing worth checking at approval time is the destination host.
              </p>
            </aside>
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
  fetch: app.handle,
} satisfies ExportedHandler<Env>
