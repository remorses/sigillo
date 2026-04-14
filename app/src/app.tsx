// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI, API routes for CRUD.
// Also serves as the Cloudflare Worker entry via the default export.
//
// Two nested layouts:
// 1. /* — HTML shell (head, body, fonts, ProgressBar)
// 2. /orgs/:orgId/projects/:projectId/* — App shell with sidebar
//
// Standalone pages (no sidebar): /, /new-org, /device

import './globals.css'
import { Spiceflow, redirect } from 'spiceflow'
import { Head, Link, ProgressBar } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import type { SecretsStore } from './secrets-store.ts'
import { Sidebar, NewProjectButton } from 'sigillo-app/src/components/sidebar'
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

  // ── Layout 1: HTML shell ──────────────────────────────────────
  .layout('/*', async ({ children }) => {
    return (
      <html lang="en">
        <Head>
          <Head.Meta charSet="UTF-8" />
          <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <Head.Title>Sigillo — Secret Manager</Head.Title>
        </Head>
        <body className="relative min-h-screen bg-background font-sans antialiased">
          <ProgressBar />
          {children ?? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Page not found
            </div>
          )}
        </body>
      </html>
    )
  })

  // ── Layout 2: App shell with sidebar ──────────────────────────
  // params.orgId and params.projectId available directly from spiceflow
  .layout('/orgs/:orgId/projects/:projectId/*', async ({ children, params, request }) => {
    const stub = getSecretsStoreStub()
    const { orgId, projectId } = params

    // Load orgs, projects, and user session in parallel — all independent
    const [orgsResult, projectsResult, sessionResult] = await Promise.allSettled([
      stub.listUserOrgs({ userId: 'system' }),
      stub.listProjects({ orgId }),
      stub.getSession(request),
    ])

    const orgs = orgsResult.status === 'fulfilled' ? orgsResult.value : []
    const projects = projectsResult.status === 'fulfilled'
      ? projectsResult.value.map((p) => ({ id: p.id, name: p.name }))
      : []
    let user: { name: string; email: string; image?: string | null } | null = null
    if (sessionResult.status === 'fulfilled' && sessionResult.value) {
      const u = sessionResult.value.user as { name?: string; email?: string; image?: string | null } | undefined
      user = { name: u?.name || 'User', email: u?.email || '', image: u?.image }
    }

    return (
      <div className="isolate relative flex max-w-[1200px] mx-auto min-h-[min(400px,100vh)]">
        <Sidebar
          orgs={orgs}
          projects={projects}
          currentOrgId={orgId}
          currentProjectId={projectId}
          user={user}
          createProjectAction={createProjectAction}
        />
        <main className="flex-1 p-6 overflow-auto">
          {children}
        </main>
      </div>
    )
  })

  // ── Root redirect → first org ─────────────────────────────────
  .get('/', async ({ request }) => {
    const stub = getSecretsStoreStub()
    const base = new URL(request.url)
    try {
      const orgs = await stub.listUserOrgs({ userId: 'system' })
      if (orgs[0]) {
        return Response.redirect(new URL(`/orgs/${orgs[0].id}`, base).toString(), 302)
      }
    } catch {}
    return Response.redirect(new URL('/new-org', base).toString(), 302)
  })

  // ── Org root redirect → first project ─────────────────────────
  .get('/orgs/:orgId', async ({ params, request }) => {
    const stub = getSecretsStoreStub()
    const base = new URL(request.url)
    try {
      const projects = await stub.listProjects({ orgId: params.orgId })
      if (projects[0]) {
        return Response.redirect(new URL(`/orgs/${params.orgId}/projects/${projects[0].id}`, base).toString(), 302)
      }
    } catch {}
    return null
  })

  // ── Org page (redirects to first project, or shows empty state) ─
  .page('/orgs/:orgId', async ({ params, request }) => {
    const stub = getSecretsStoreStub()

    const [orgsResult, projectsResult, sessionResult] = await Promise.allSettled([
      stub.listUserOrgs({ userId: 'system' }),
      stub.listProjects({ orgId: params.orgId }),
      stub.getSession(request),
    ])

    const projects = projectsResult.status === 'fulfilled'
      ? projectsResult.value.map((p) => ({ id: p.id, name: p.name }))
      : []

    if (projects[0]) {
      return redirect(`/orgs/${params.orgId}/projects/${projects[0].id}`)
    }

    const orgs = orgsResult.status === 'fulfilled' ? orgsResult.value : []

    let user: { name: string; email: string; image?: string | null } | null = null
    if (sessionResult.status === 'fulfilled' && sessionResult.value) {
      const u = sessionResult.value.user as { name?: string; email?: string; image?: string | null } | undefined
      user = { name: u?.name || 'User', email: u?.email || '', image: u?.image }
    }

    return (
      <div className="isolate relative flex max-w-[1200px] mx-auto min-h-[min(400px,100vh)]">
        <Sidebar orgs={orgs} projects={[]} currentOrgId={params.orgId} currentProjectId={null} user={user} createProjectAction={createProjectAction} />
        <main className="flex-1 p-6 overflow-auto">
          <div className="max-w-3xl">
            <h1 className="text-2xl font-bold tracking-tight mb-2">No projects yet</h1>
            <p className="text-muted-foreground mb-6">Create your first project to start managing secrets.</p>
            <NewProjectButton orgId={params.orgId} createProjectAction={createProjectAction} />
          </div>
        </main>
      </div>
    )
  })



  // ── New Organization page (standalone, no sidebar) ─────────────
  .page('/new-org', async () => {
    async function createOrgAction(_prev: string, formData: FormData) {
      'use server'
      const name = formData.get('name') as string
      if (!name) return 'Name is required'
      const stub = getSecretsStoreStub()
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

  // ── Project root redirect → first env ─────────────────────────
  // .page() registers both GET and POST, so this handles full-page loads,
  // client-side RSC navigation, and server action POSTs.
  .page('/orgs/:orgId/projects/:id', async ({ params }) => {
    const stub = getSecretsStoreStub()
    const environments = await stub.listEnvironments({ projectId: params.id })
    const firstEnvId = environments[0]?.id || '_'
    return redirect(`/orgs/${params.orgId}/projects/${params.id}/envs/${firstEnvId}`)
  })

  // ── Project detail with env ───────────────────────────────────
  .page('/orgs/:orgId/projects/:projectId/envs/:envId', async ({ params }) => {
    const stub = getSecretsStoreStub()
    const { orgId, projectId, envId } = params

    // Load project info and environments in parallel — both independent
    const [allProjects, environments] = await Promise.all([
      stub.listProjects({ orgId }),
      stub.listEnvironments({ projectId }),
    ])

    const project = allProjects.find((p) => p.id === projectId)
    if (!project) {
      return (
        <div className="text-center py-12">
          <h1 className="text-xl font-semibold mb-2">Project not found</h1>
          <Link href="/" className="text-primary hover:underline">Back to dashboard</Link>
        </div>
      )
    }

    // Resolve env from path param, then load secrets (depends on resolved envId)
    const selectedEnvId = environments.some((e) => e.id === envId)
      ? envId
      : environments[0]?.id || null

    const secrets = selectedEnvId
      ? await stub.listSecrets({ environmentId: selectedEnvId })
      : []

    // dataKey changes every server render, forcing client component remount
    // so useState(initialSecrets) picks up fresh data after router.refresh()
    const dataKey = `${selectedEnvId}-${Date.now()}`

    return (
      <div>
        <ProjectPage
          key={dataKey}
          projectId={projectId}
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

  // ── Device flow verification page (standalone, no sidebar) ─────
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
      const envResult = await stub.createEnvironment({ projectId: params.projectId, name: body.name, slug: body.slug })
      return { ok: true, ...envResult }
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
