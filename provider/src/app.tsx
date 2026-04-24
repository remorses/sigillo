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


function ConsentScreen({ redirectDomain }: { redirectDomain: string | null }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      <section className="w-full max-w-sm">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium text-foreground">Sigillo Auth</p>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
            Sign in to continue
          </h1>
        </div>

        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {redirectDomain ? (
            <>
              <span className="font-medium text-foreground">{redirectDomain}</span> wants to use your Sigillo account.
            </>
          ) : (
            'An app wants to use your Sigillo account.'
          )}
        </p>

        <p className="mt-4 text-sm leading-6 text-muted-foreground">
          Only continue if you trust this domain.
        </p>

        <div className="mt-6">
          <ConsentButtons />
        </div>
      </section>
    </main>
  )
}

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

    return <ConsentScreen redirectDomain={redirectDomain} />
  })

  // Preview route to see consent UI without initiating an auth flow
  .page('/consent-preview', async () => {
    return <ConsentScreen redirectDomain="my-app.example.com" />
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
