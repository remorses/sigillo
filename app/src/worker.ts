// Cloudflare Worker entry for the self-hosted secret sharing app.
// Routes requests to BetterAuth (auth API) or Spiceflow (pages + API).

import { app } from './app.tsx'
export { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub(env: Env) {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // BetterAuth handles /api/auth/* routes
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getSecretsStoreStub(env)
      return stub.fetch(request)
    }

    // Everything else goes through Spiceflow
    return app.handle(request, { state: { env } })
  },
} satisfies ExportedHandler<Env>
