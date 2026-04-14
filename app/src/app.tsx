// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI, API routes for CRUD, setup endpoint.
// Also serves as the Cloudflare Worker entry via the default export.
//
// UI: shadcn components with sidebar layout.
// - Sidebar: org dropdown, project list, new org/project forms via server actions
// - Main area: environments table + secrets table (Doppler-style hidden values)

import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head, Link, ProgressBar } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import type { SecretsStore } from './secrets-store.ts'
import { Sidebar } from 'sigillo-app/src/components/sidebar'
import { ProjectPage } from 'sigillo-app/src/components/project-page'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'

export { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

// ── Server action helpers (used in pages) ───────────────────────

async function createProjectAction(_prev: string, formData: FormData) {
  'use server'
  const name = formData.get('name') as string
  const orgId = formData.get('orgId') as string
  if (!name) return 'Name is required'
  if (!orgId) return 'No org selected'
  const stub = getSecretsStoreStub()
  const project = await stub.createProject({ name, orgId })
  return `Created:${project.id}`
}

async function createSecretAction(_prev: string, formData: FormData) {
  'use server'
  const name = formData.get('name') as string
  const value = formData.get('value') as string
  const environmentId = formData.get('environmentId') as string
  if (!name || !value) return 'Key and value are required'
  const stub = getSecretsStoreStub()
  await stub.createSecret({ environmentId, name, value, createdBy: 'system' })
  return `Created ${name}`
}

async function deleteSecretAction(id: string) {
  'use server'
  const stub = getSecretsStoreStub()
  await stub.deleteSecret({ id })
}

async function fetchSecretsForEnv(envId: string) {
  'use server'
  const stub = getSecretsStoreStub()
  return stub.listSecrets({ environmentId: envId })
}

async function saveSecretsAction(edits: { id: string; name?: string; value?: string }[]) {
  'use server'
  const stub = getSecretsStoreStub()
  for (const edit of edits) {
    await stub.updateSecret({ id: edit.id, name: edit.name, value: edit.value })
  }
}

async function deleteEnvAction(id: string) {
  'use server'
  const stub = getSecretsStoreStub()
  await stub.deleteEnvironment({ id })
}

async function createEnvAction(_prev: string, formData: FormData) {
  'use server'
  const name = formData.get('name') as string
  const slug = formData.get('slug') as string
  const projectId = formData.get('projectId') as string
  if (!name || !slug) return 'Name and slug are required'
  const stub = getSecretsStoreStub()
  await stub.createEnvironment({ projectId, name, slug })
  return `Created ${name}`
}

export const app = new Spiceflow({
  // Allow tunnel origins for server actions (CSRF check)
  allowedActionOrigins: [/\.kimaki\.dev$/],
})

  // ── Root layout with sidebar ──────────────────────────────────
  .layout('/*', async ({ children, request }) => {
    const url = new URL(request.url)
    const orgId = url.searchParams.get('orgId')

    // Load orgs and projects for the sidebar
    const stub = getSecretsStoreStub()
    let orgs: { id: string; name: string; role: string }[] = []
    let projects: { id: string; name: string }[] = []

    try {
      // TODO: scope to authenticated user
      orgs = await stub.listUserOrgs({ userId: 'system' })
    } catch {
      // No orgs yet
    }

    const effectiveOrgId = orgId || orgs[0]?.id || null

    if (effectiveOrgId) {
      try {
        const result = await stub.listProjects({ orgId: effectiveOrgId })
        projects = result.map((p) => ({ id: p.id, name: p.name }))
      } catch {
        // No projects yet
      }
    }

    // Extract current project id from pathname
    const projectMatch = url.pathname.match(/^\/projects\/(.+)/)
    const currentProjectId = projectMatch?.[1] || null

    // Try to get current user session
    let user: { name: string; email: string; image?: string | null } | null = null
    try {
      const session = await stub.getSession(request)
      if (session) {
        const u = session.user as { name?: string; email?: string; image?: string | null } | undefined
        user = { name: u?.name || 'User', email: u?.email || '', image: u?.image }
      }
    } catch {
      // Not authenticated yet
    }

    return (
      <html lang="en">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Sigillo — Secret Manager</Head.Title>
        </Head>
        <body className="relative min-h-screen bg-background font-sans antialiased">
          <ProgressBar />
          <div className="isolate relative flex max-w-[1200px] mx-auto min-h-[min(400px,100vh)]">
            <Sidebar
              orgs={orgs}
              projects={projects}
              currentOrgId={effectiveOrgId}
              currentProjectId={currentProjectId}
              user={user}
              createProjectAction={createProjectAction}
            />
            <main className="flex-1 p-6 overflow-auto">
              {children ?? (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Page not found
                </div>
              )}
            </main>
          </div>
        </body>
      </html>
    )
  })

  // ── Dashboard ─────────────────────────────────────────────────
  .page('/', async () => {
    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight mb-2">Dashboard</h1>
        <p className="text-muted-foreground">
          Select an organization and project from the sidebar, or create new ones to get started.
        </p>
      </div>
    )
  })

  // ── New Organization page ───────────────────────────────────────
  .page('/new-org', async () => {
    async function createOrgAction(_prev: string, formData: FormData) {
      'use server'
      const name = formData.get('name') as string
      if (!name) return 'Name is required'
      const stub = getSecretsStoreStub()
      // TODO: get userId from session
      const org = await stub.createOrg({ name, userId: 'system' })
      return `Created:${org.id}`
    }

    return (
      <div className="max-w-md mx-auto py-12">
        <h1 className="text-2xl font-bold tracking-tight mb-2">New Organization</h1>
        <p className="text-muted-foreground mb-6">
          Organizations group your projects and team members.
        </p>
        <CreateOrgForm action={createOrgAction} />
      </div>
    )
  })

  // ── Project detail ────────────────────────────────────────────
  .page('/projects/:id', async ({ params, request }) => {
    const stub = getSecretsStoreStub()
    const url = new URL(request.url)
    const orgId = url.searchParams.get('orgId') || ''

    // Load project info
    const allProjects = await stub.listProjects({ orgId })
    const project = allProjects.find((p) => p.id === params.id)
    if (!project) {
      return (
        <div className="text-center py-12">
          <h1 className="text-xl font-semibold mb-2">Project not found</h1>
          <Link href="/" className="text-primary hover:underline">Back to dashboard</Link>
        </div>
      )
    }

    // Load environments
    const environments = await stub.listEnvironments({ projectId: params.id })

    // Resolve selected env from URL or default to first
    const envIdParam = url.searchParams.get('envId')
    const selectedEnvId = envIdParam && environments.some((e) => e.id === envIdParam)
      ? envIdParam
      : environments[0]?.id || null

    // Load secrets for the selected environment
    let secrets: { id: string; name: string; createdAt: number; updatedAt: number; createdBy: { id: string; name: string } | null }[] = []
    if (selectedEnvId) {
      secrets = await stub.listSecrets({ environmentId: selectedEnvId })
    }

    return (
      <div>
        <ProjectPage
          key={selectedEnvId}
          projectId={params.id}
          projectName={project.name}
          orgId={orgId}
          environments={environments}
          selectedEnvId={selectedEnvId}
          secrets={secrets}
          fetchSecretsForEnv={fetchSecretsForEnv}
          deleteSecretAction={deleteSecretAction}
          createSecretAction={createSecretAction}
          saveSecretsAction={saveSecretsAction}
        />
      </div>
    )
  })

  // ── Device flow verification page ──────────────────────────────
  .page('/device', async () => {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold mb-2">Device Login</h1>
          <p className="text-muted-foreground mb-6">Enter the code shown on your CLI or agent:</p>
          <form method="POST" action="/api/auth/device/verify" className="flex flex-col gap-4">
            <input
              name="user_code"
              placeholder="ABCD-EFGH"
              className="h-12 rounded-lg border border-input bg-background px-4 text-center text-2xl font-mono tracking-[0.25em] uppercase focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              type="submit"
              className="h-10 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer"
            >
              Verify Code
            </button>
          </form>
        </div>
      </div>
    )
  })

  // ── API: Setup ────────────────────────────────────────────────
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

  // ── API: Orgs ─────────────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/orgs',
    request: z.object({
      name: z.string().min(1),
    }),
    async handler({ request }) {
      const body = await request.json()
      const stub = getSecretsStoreStub()
      const session = await stub.getSession(request)
      if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      const org = await stub.createOrg({ name: body.name, userId: session.userId })
      return { ok: true, ...org }
    },
  })

  .route({
    method: 'GET',
    path: '/api/orgs',
    async handler({ request }) {
      const stub = getSecretsStoreStub()
      const session = await stub.getSession(request)
      if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      const orgs = await stub.listUserOrgs({ userId: session.userId })
      return { orgs }
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
