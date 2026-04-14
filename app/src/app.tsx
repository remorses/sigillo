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
import { createOrgAction, createProjectAction } from './actions.ts'
import { Sidebar, NewProjectButton } from 'sigillo-app/src/components/sidebar'
import { ProjectPage } from 'sigillo-app/src/components/project-page'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'

// Auth helper: extracts session from request via DO RPC.
// Returns session or redirects to login for pages, returns 401 for API routes.
async function requireApiSession(stub: DurableObjectStub<SecretsStore>, request: Request) {
  const session = await stub.getSession(request)
  if (!session) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  return session
}

async function requirePageSession(stub: DurableObjectStub<SecretsStore>, request: Request) {
  const session = await stub.getSession(request)
  if (!session) throw redirect('/login')
  return session
}

// Verifies the user is a member of the given org. Throws 403 Response for API routes.
async function requireApiOrgMember(stub: DurableObjectStub<SecretsStore>, userId: string, orgId: string) {
  try {
    return await stub.requireOrgMember({ userId, orgId })
  } catch {
    throw new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
}

async function requirePageOrgMember(stub: DurableObjectStub<SecretsStore>, userId: string, orgId: string) {
  try {
    return await stub.requireOrgMember({ userId, orgId })
  } catch {
    throw redirect('/')
  }
}




export { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

export const app = new Spiceflow({
  // Allow tunnel origins for server actions (CSRF check)
  allowedActionOrigins: [/\.kimaki\.dev$/],
})

  // ── BetterAuth middleware ──────────────────────────────────────
  // Forward /api/auth/* requests to the DO's BetterAuth handler.
  // Falls through on 404 so we can register our own /api/auth/* routes.
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const stub = getSecretsStoreStub()
      const res = await stub.authHandler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
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

    const session = await requirePageSession(stub, request)
    await requirePageOrgMember(stub, session.userId, orgId)

    // Load orgs + projects in parallel — both independent, session already resolved
    const [orgs, allProjects] = await Promise.all([
      stub.listUserOrgs({ userId: session.userId }),
      stub.listProjects({ orgId }),
    ])

    const projects = allProjects.map((p) => ({ id: p.id, name: p.name }))
    const user = { name: session.user.name || 'User', email: session.user.email || '' }

    return (
      <div className="isolate relative flex max-w-[1200px] mx-auto min-h-[min(400px,100vh)]">
        <Sidebar
          orgs={orgs}
          projects={projects}
          currentOrgId={orgId}
          currentProjectId={projectId}
          user={user}
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
    const session = await stub.getSession(request)
    if (!session) return redirect('/login')
    const base = new URL(request.url)
    try {
      const orgs = await stub.listUserOrgs({ userId: session.userId })
      if (orgs[0]) {
        return Response.redirect(new URL(`/orgs/${orgs[0].id}`, base).toString(), 302)
      }
    } catch {}
    return Response.redirect(new URL('/new-org', base).toString(), 302)
  })

  // ── Org root redirect → first project ─────────────────────────
  .get('/orgs/:orgId', async ({ params, request }) => {
    const stub = getSecretsStoreStub()
    const session = await requirePageSession(stub, request)
    await requirePageOrgMember(stub, session.userId, params.orgId)
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
    const session = await requirePageSession(stub, request)
    await requirePageOrgMember(stub, session.userId, params.orgId)

    const [orgs, projects] = await Promise.all([
      stub.listUserOrgs({ userId: session.userId }),
      stub.listProjects({ orgId: params.orgId }),
    ])

    const projectList = projects.map((p) => ({ id: p.id, name: p.name }))

    if (projectList[0]) {
      return redirect(`/orgs/${params.orgId}/projects/${projectList[0].id}`)
    }

    const user = { name: session.user.name || 'User', email: session.user.email || '' }

    return (
      <div className="isolate relative flex max-w-[1200px] mx-auto min-h-[min(400px,100vh)]">
        <Sidebar orgs={orgs} projects={[]} currentOrgId={params.orgId} currentProjectId={null} user={user} />
        <main className="flex-1 p-6 overflow-auto">
          <div className="max-w-3xl">
            <h1 className="text-2xl font-bold tracking-tight mb-2">No projects yet</h1>
            <p className="text-muted-foreground mb-6">Create your first project to start managing secrets.</p>
            <NewProjectButton orgId={params.orgId} />
          </div>
        </main>
      </div>
    )
  })



  // ── New Organization page (standalone, no sidebar) ─────────────
  .page('/new-org', async ({ request }) => {
    const stub = getSecretsStoreStub()
    await requirePageSession(stub, request)
    return (
      <div className="max-w-md mx-auto py-12">
        <h1 className="text-2xl font-bold tracking-tight mb-2">New Organization</h1>
        <p className="text-muted-foreground mb-6">
          Organizations group your projects and team members.
        </p>
        <CreateOrgForm />
      </div>
    )
  })

  // ── Project root redirect → first env ─────────────────────────
  // .page() registers both GET and POST, so this handles full-page loads,
  // client-side RSC navigation, and server action POSTs.
  // Auth is already checked by the parent layout for /orgs/:orgId/projects/:projectId/*
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
      ? await stub.listSecretsWithValues({ environmentId: selectedEnvId })
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

  // ── Login page (standalone, no sidebar) ─────────────────────────
  // Shows a sign-in button. If already logged in, redirects to dashboard.
  // The button triggers a client-side fetch to BetterAuth's genericOAuth
  // endpoint which returns a redirect URL to the provider.
  .page('/login', async ({ request }) => {
    const stub = getSecretsStoreStub()
    const session = await stub.getSession(request)
    if (session) return redirect('/')
    const { LoginButton } = await import('sigillo-app/src/components/login-button')
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold tracking-tight mb-2">Sigillo</h1>
          <p className="text-muted-foreground mb-6">Sign in to manage your secrets</p>
          <LoginButton />
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
      const session = await requireApiSession(stub, request)
      await requireApiOrgMember(stub, session.userId, body.orgId)
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
      const session = await requireApiSession(stub, request)
      await requireApiOrgMember(stub, session.userId, orgId)
      const projects = await stub.listProjects({ orgId })
      return { projects }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/projects/:id',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForProject({ projectId: params.id })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
      const deleted = await stub.deleteProject({ id: params.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Environments ─────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/projects/:projectId/environments',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForProject({ projectId: params.projectId })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
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
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForProject({ projectId: params.projectId })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
      const envResult = await stub.createEnvironment({ projectId: params.projectId, name: body.name, slug: body.slug })
      return { ok: true, ...envResult }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:id',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForEnvironment({ environmentId: params.id })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
      const deleted = await stub.deleteEnvironment({ id: params.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Secrets (scoped to environment) ──────────────────────
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForEnvironment({ environmentId: params.environmentId })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
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
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForEnvironment({ environmentId: params.environmentId })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
      const secret = await stub.createSecret({ environmentId: params.environmentId, name: body.name, value: body.value, createdBy: session.userId })
      return { ok: true, environmentId: params.environmentId, id: secret.id, name: secret.name }
    },
  })

  .route({
    method: 'GET',
    path: '/api/secrets/:id',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForSecret({ secretId: params.id })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
      const secret = await stub.getSecret({ id: params.id })
      if (!secret) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return secret
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/secrets/:id',
    async handler({ params, request }) {
      const stub = getSecretsStoreStub()
      const session = await requireApiSession(stub, request)
      const orgId = await stub.getOrgIdForSecret({ secretId: params.id })
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(stub, session.userId, orgId)
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

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
