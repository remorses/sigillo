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

  // ── Device flow verification page ──────────────────────────────
  // CLI/agents get a user_code and send the user here to enter it.
  // User must be logged in (via provider) to approve the device code.
  .page('/device', async () => {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 400 }}>
          <h1>Device Login</h1>
          <p>Enter the code shown on your CLI or agent:</p>
          <form method="POST" action="/api/auth/device/verify" style={{ marginTop: 24 }}>
            <input
              name="user_code"
              placeholder="ABCD-EFGH"
              style={{
                padding: '12px 16px',
                fontSize: 24,
                fontFamily: 'monospace',
                textAlign: 'center',
                letterSpacing: 4,
                textTransform: 'uppercase',
                border: '2px solid #ddd',
                borderRadius: 8,
                width: '100%',
                boxSizing: 'border-box',
              }}
            />
            <button
              type="submit"
              style={{
                marginTop: 16,
                padding: '12px 24px',
                background: '#4285f4',
                color: 'white',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
                fontWeight: 600,
                width: '100%',
              }}
            >
              Verify Code
            </button>
          </form>
        </div>
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

  // ── API: Projects ──────────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/projects',
    request: z.object({
      name: z.string().min(1),
      orgId: z.string().min(1),
    }),
    async handler({ request }) {
      const body = await request.json()
      const stub = getSecretsStoreStub()
      const session = await stub.getSession(request)
      if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      const project = await stub.createProject({ name: body.name, orgId: body.orgId })
      return { ok: true, ...project }
    },
  })

  .route({
    method: 'GET',
    path: '/api/projects',
    async handler({ request }) {
      const url = new URL(request.url)
      const orgId = url.searchParams.get('orgId')
      if (!orgId) return new Response(JSON.stringify({ error: 'orgId required' }), { status: 400 })
      const stub = getSecretsStoreStub()
      const projects = await stub.listProjects({ orgId })
      return { projects }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/projects/:id',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const deleted = await stub.deleteProject({ id: params.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Environments ─────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/projects/:projectId/environments',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const environments = await stub.listEnvironments({ projectId: params.projectId })
      return { projectId: params.projectId, environments }
    },
  })

  .route({
    method: 'POST',
    path: '/api/projects/:projectId/environments',
    request: z.object({
      name: z.string().min(1),
      slug: z.string().min(1),
    }),
    async handler({ request, params }) {
      const body = await request.json()
      const stub = getSecretsStoreStub()
      const env = await stub.createEnvironment({ projectId: params.projectId, name: body.name, slug: body.slug })
      return { ok: true, ...env }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:id',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const deleted = await stub.deleteEnvironment({ id: params.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Secrets (scoped to environment) ──────────────────────
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const secrets = await stub.listSecrets({ environmentId: params.environmentId })
      return { environmentId: params.environmentId, secrets }
    },
  })

  .route({
    method: 'POST',
    path: '/api/environments/:environmentId/secrets',
    request: z.object({
      name: z.string().min(1),
      value: z.string().min(1),
    }),
    async handler({ request, params }) {
      const body = await request.json()
      const stub = getSecretsStoreStub()
      const session = await stub.getSession(request)
      if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      const secret = await stub.createSecret({ environmentId: params.environmentId, name: body.name, value: body.value, createdBy: session.userId })
      return { ok: true, environmentId: params.environmentId, id: secret.id, name: secret.name }
    },
  })

  .route({
    method: 'GET',
    path: '/api/secrets/:id',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const secret = await stub.getSecret({ id: params.id })
      if (!secret) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return secret
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/secrets/:id',
    async handler({ params }) {
      const stub = getSecretsStoreStub()
      const deleted = await stub.deleteSecret({ id: params.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
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
