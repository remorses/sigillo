// Cloudflare Worker entry for the middleman OAuth provider.
// Routes requests to BetterAuth (via DO RPC) or Spiceflow (pages).
// Uses a single AuthStore DO instance (named "main") for all data.
//
// BetterAuth's oauthProvider handles these routes inside the DO:
// - /api/auth/*           — core auth + oauth provider endpoints
// - /.well-known/*        — OIDC discovery metadata

import { app } from './app.tsx'

export { AuthStore } from './auth-store.ts'

function getAuthStoreStub(env: Env) {
  const id = env.AUTH_STORE.idFromName('main')
  return env.AUTH_STORE.get(id)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Forward auth API + OIDC discovery to BetterAuth inside the DO via RPC
    if (url.pathname.startsWith('/api/auth') || url.pathname.startsWith('/.well-known/')) {
      const stub = getAuthStoreStub(env)
      return stub.authHandler(request)
    }

    // Everything else goes through Spiceflow (pages, health, etc.)
    return app.handle(request, { state: { env } })
  },
} satisfies ExportedHandler<Env>
