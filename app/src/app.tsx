// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI, API routes for CRUD, setup endpoint.
// Also serves as the Cloudflare Worker entry via the default export.

import { Spiceflow } from 'spiceflow'
import { Head, Link } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import type { SecretsStore } from './secrets-store.ts'

export { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

export const app = new Spiceflow()

  // ── Root layout ───────────────────────────────────────────────
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Sigillo — Secret Manager</Head.Title>
        </Head>
        <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '0 20px' }}>
          <nav style={{ padding: '16px 0', borderBottom: '1px solid #eee' }}>
            <Link href={app.href('/')}>
              <strong>Sigillo</strong>
            </Link>
          </nav>
          {children}
        </body>
      </html>
    )
  })

  // ── Dashboard ─────────────────────────────────────────────────
  .page('/', async () => {
    return (
      <div style={{ maxWidth: 800, margin: '40px auto' }}>
        <h1>Dashboard</h1>
        <p>Your self-hosted secret manager.</p>
        <Link href={app.href('/projects')}>View Projects</Link>
      </div>
    )
  })

  // ── Projects list ─────────────────────────────────────────────
  .page('/projects', async () => {
    return (
      <div style={{ maxWidth: 800, margin: '40px auto' }}>
        <h1>Projects</h1>
        <p>Manage your secret projects.</p>
      </div>
    )
  })

  // ── Project detail ────────────────────────────────────────────
  .page('/projects/:id', async ({ params }) => {
    return (
      <div style={{ maxWidth: 800, margin: '40px auto' }}>
        <h1>Project {params.id}</h1>
        <p>Secrets for this project.</p>
      </div>
    )
  })

  // ── API: Setup ────────────────────────────────────────────────
  // Registers with the middleman provider via the DO's setup RPC method.
  .route({
    method: 'POST',
    path: '/api/setup',
    async handler({ request }) {
      const url = new URL(request.url)
      const appUrl = `${url.protocol}//${url.host}`
      const stub = getSecretsStoreStub()
      const result = await stub.setup({ appUrl })
      return { ok: true, clientId: result.clientId }
    },
  })

  // ── API: List secrets ─────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/projects/:projectId/secrets',
    async handler({ params }) {
      // TODO: query DO for secrets list (names only, not values)
      return { projectId: params.projectId, secrets: [] as string[] }
    },
  })

  // ── API: Create secret ────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/projects/:projectId/secrets',
    request: z.object({
      name: z.string().min(1),
      value: z.string().min(1),
    }),
    async handler({ request, params }) {
      const body = await request.json()
      // TODO: encrypt and store in DO
      return { ok: true, projectId: params.projectId, name: body.name }
    },
  })

  // ── API: Read secret ──────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/secrets/:id',
    async handler({ params }) {
      // TODO: decrypt and return from DO
      return { id: params.id, value: '' }
    },
  })

  // ── API: Delete secret ────────────────────────────────────────
  .route({
    method: 'DELETE',
    path: '/api/secrets/:id',
    async handler({ params }) {
      // TODO: delete from DO
      return { ok: true, id: params.id }
    },
  })

  // ── Health ────────────────────────────────────────────────────
  .get('/health', () => {
    return { ok: true, service: 'sigillo-app' }
  })

export type App = typeof app

// Cloudflare Worker entry — routes auth to DO, everything else to Spiceflow
export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Forward auth requests to BetterAuth inside the DO via RPC
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getSecretsStoreStub()
      return stub.authHandler(request)
    }

    // Everything else goes through Spiceflow
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
