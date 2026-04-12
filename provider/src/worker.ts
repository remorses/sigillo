// Cloudflare Worker entry for the middleman OAuth provider.
// Routes requests to BetterAuth (auth API) or Spiceflow (pages).
// Uses a single AuthStore DO instance (named "main") for all data.

import { app } from './app.tsx'
import { createAuth } from './auth.ts'

export { AuthStore } from './auth-store.ts'

function getAuthStoreStub(env: Env) {
  const id = env.AUTH_STORE.idFromName('main')
  return env.AUTH_STORE.get(id)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // BetterAuth handles /api/auth/* routes
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getAuthStoreStub(env)
      // Get the drizzle db from the DO — we need to call an RPC method
      // that creates the auth instance and handles the request inside the DO
      return stub.fetch(request)
    }

    // Everything else goes through Spiceflow (pages, health, etc.)
    return app.handle(request, { state: { env } })
  },
} satisfies ExportedHandler<Env>
