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
import * as orm from 'drizzle-orm'
import { z } from 'zod'
import * as schema from 'db/src/app-schema.ts'
import {
  getDb, getAuth, getSession,
  requireApiSession, requirePageSession,
  requireApiOrgMember, requirePageOrgMember,
  getOrgIdForProject, getOrgIdForEnvironment, getOrgIdForSecret,
  encrypt, decrypt,
} from './db.ts'
import { createOrgAction, createProjectAction } from './actions.ts'
import { Sidebar, NewProjectButton } from 'sigillo-app/src/components/sidebar'
import { ProjectPage } from 'sigillo-app/src/components/project-page'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'

export { SecretsStore } from './secrets-store.ts'

export const app = new Spiceflow({
  // Allow tunnel origins for server actions (CSRF check)
  allowedActionOrigins: [/\.kimaki\.dev$/],
})

  // ── BetterAuth middleware ──────────────────────────────────────
  // BetterAuth runs in the worker, not the DO. Only SQL crosses the
  // DO boundary via sqlite-proxy.
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const auth = await getAuth()
      const res = await auth.handler(request)
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
  .layout('/orgs/:orgId/projects/:projectId/*', async ({ children, params, request }) => {
    const { orgId, projectId } = params
    const db = getDb()

    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, orgId)

    const [members, allProjects] = await Promise.all([
      db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      }),
      db.query.project.findMany({
        where: { orgId },
        with: { environments: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const orgs = members.filter((m) => m.org != null).map((m) => ({
      id: m.org!.id!, name: m.org!.name!, role: m.role,
      createdAt: m.org!.createdAt!, updatedAt: m.org!.updatedAt!,
    }))
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
    const session = await getSession(request.headers)
    if (!session) return redirect('/login')
    const db = getDb()
    const base = new URL(request.url)
    try {
      const members = await db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      })
      const firstOrg = members.find((m) => m.org != null)
      if (firstOrg) {
        return Response.redirect(new URL(`/orgs/${firstOrg.org!.id}`, base).toString(), 302)
      }
    } catch {}
    return Response.redirect(new URL('/new-org', base).toString(), 302)
  })

  // ── Org root redirect → first project ─────────────────────────
  .get('/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()
    const base = new URL(request.url)
    try {
      const projects = await db.query.project.findMany({
        where: { orgId: params.orgId },
        orderBy: { createdAt: 'desc' },
      })
      if (projects[0]) {
        return Response.redirect(new URL(`/orgs/${params.orgId}/projects/${projects[0].id}`, base).toString(), 302)
      }
    } catch {}
    return null
  })

  // ── Org page (redirects to first project, or shows empty state) ─
  .page('/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()

    const [members, projects] = await Promise.all([
      db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      }),
      db.query.project.findMany({
        where: { orgId: params.orgId },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const orgs = members.filter((m) => m.org != null).map((m) => ({
      id: m.org!.id!, name: m.org!.name!, role: m.role,
      createdAt: m.org!.createdAt!, updatedAt: m.org!.updatedAt!,
    }))
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
    await requirePageSession(request)
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
  .page('/orgs/:orgId/projects/:id', async ({ params }) => {
    const db = getDb()
    const environments = await db.query.environment.findMany({
      where: { projectId: params.id },
      orderBy: { createdAt: 'asc' },
    })
    const firstEnvId = environments[0]?.id || '_'
    return redirect(`/orgs/${params.orgId}/projects/${params.id}/envs/${firstEnvId}`)
  })

  // ── Project detail with env ───────────────────────────────────
  .page('/orgs/:orgId/projects/:projectId/envs/:envId', async ({ params }) => {
    const db = getDb()
    const { orgId, projectId, envId } = params

    const [allProjects, environments] = await Promise.all([
      db.query.project.findMany({
        where: { orgId },
        with: { environments: true },
        orderBy: { createdAt: 'desc' },
      }),
      db.query.environment.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
      }),
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

    const selectedEnvId = environments.some((e) => e.id === envId)
      ? envId
      : environments[0]?.id || null

    // Load secrets and decrypt values
    let secrets: { id: string; name: string; value: string; createdAt: number; updatedAt: number; createdBy: { id: string; name: string } | null }[] = []
    if (selectedEnvId) {
      const rows = await db.query.secret.findMany({
        where: { environmentId: selectedEnvId },
        with: { creator: { columns: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      })
      secrets = await Promise.all(rows.map(async (r) => ({
        id: r.id, name: r.name,
        value: await decrypt(r.valueEncrypted, r.iv),
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        createdBy: r.creator,
      })))
    }

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
  // Uses the proper BetterAuth device authorization client flow:
  // 1. Validate code via authClient.device({ query: { user_code } })
  // 2. Approve/deny via authClient.device.approve() / .deny()
  .page('/device', async ({ request }) => {
    // User must be logged in to approve device codes
    const session = await getSession(request.headers)
    if (!session) return redirect('/login')
    const { DeviceFlow } = await import('sigillo-app/src/components/device-flow')
    return <DeviceFlow />
  })

  // ── Login page (standalone, no sidebar) ─────────────────────────
  .page('/login', async ({ request }) => {
    const session = await getSession(request.headers)
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
    request: z.object({ name: z.string().min(1) }),
    async handler({ request }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const db = getDb()
      const [org] = await db.insert(schema.org).values({ name: body.name }).returning({ id: schema.org.id, name: schema.org.name })
      await db.insert(schema.orgMember).values({ orgId: org!.id, userId: session.userId, role: 'admin' })
      return { ok: true, ...org! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/orgs',
    async handler({ request }) {
      const session = await requireApiSession(request)
      const db = getDb()
      const members = await db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      })
      const orgs = members.filter((m) => m.org != null).map((m) => ({
        id: m.org!.id!, name: m.org!.name!, role: m.role,
        createdAt: m.org!.createdAt!, updatedAt: m.org!.updatedAt!,
      }))
      return { orgs }
    },
  })

  // ── API: Projects ──────────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/projects',
    request: z.object({ name: z.string().min(1), orgId: z.string().min(1) }),
    async handler({ request }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      await requireApiOrgMember(session.userId, body.orgId)
      const db = getDb()
      const [proj] = await db.insert(schema.project).values({ name: body.name, orgId: body.orgId })
        .returning({ id: schema.project.id, name: schema.project.name })
      for (const e of schema.DEFAULT_ENVIRONMENTS) {
        await db.insert(schema.environment).values({ projectId: proj!.id, name: e.name, slug: e.slug })
      }
      return { ok: true, ...proj! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/projects',
    async handler({ request }) {
      const url = new URL(request.url)
      const orgId = url.searchParams.get('orgId')
      if (!orgId) return new Response(JSON.stringify({ error: 'orgId required' }), { status: 400 })
      const session = await requireApiSession(request)
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const projects = await db.query.project.findMany({ where: { orgId }, with: { environments: true }, orderBy: { createdAt: 'desc' } })
      return { projects }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/projects/:id',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [deleted] = await db.delete(schema.project).where(orm.eq(schema.project.id, params.id)).returning({ id: schema.project.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Environments ─────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/projects/:projectId/environments',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const environments = await db.query.environment.findMany({ where: { projectId: params.projectId }, orderBy: { createdAt: 'asc' } })
      return { projectId: params.projectId, environments }
    },
  })

  .route({
    method: 'POST',
    path: '/api/projects/:projectId/environments',
    request: z.object({ name: z.string().min(1), slug: z.string().min(1) }),
    async handler({ request, params }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [row] = await db.insert(schema.environment).values({ projectId: params.projectId, name: body.name, slug: body.slug })
        .returning({ id: schema.environment.id, name: schema.environment.name, slug: schema.environment.slug })
      return { ok: true, ...row! }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:id',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.id)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [deleted] = await db.delete(schema.environment).where(orm.eq(schema.environment.id, params.id)).returning({ id: schema.environment.id })
      if (!deleted) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── API: Secrets (scoped to environment) ──────────────────────
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.environmentId)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const rows = await db.query.secret.findMany({
        where: { environmentId: params.environmentId },
        with: { creator: { columns: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      })
      const secrets = rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.creator }))
      return { environmentId: params.environmentId, secrets }
    },
  })

  .route({
    method: 'POST',
    path: '/api/environments/:environmentId/secrets',
    request: z.object({ name: z.string().min(1), value: z.string().min(1) }),
    async handler({ request, params }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.environmentId)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const { encrypted, iv } = await encrypt(body.value)
      const [row] = await db.insert(schema.secret).values({
        environmentId: params.environmentId, name: body.name,
        valueEncrypted: encrypted, iv, createdBy: session.userId,
      }).returning({ id: schema.secret.id, name: schema.secret.name })
      return { ok: true, environmentId: params.environmentId, id: row!.id, name: row!.name }
    },
  })

  .route({
    method: 'GET',
    path: '/api/secrets/:id',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForSecret(params.id)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const row = await db.query.secret.findFirst({ where: { id: params.id } })
      if (!row) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      const value = await decrypt(row.valueEncrypted, row.iv)
      return { id: row.id, name: row.name, value, environmentId: row.environmentId, createdAt: row.createdAt, updatedAt: row.updatedAt }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/secrets/:id',
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForSecret(params.id)
      if (!orgId) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [deleted] = await db.delete(schema.secret).where(orm.eq(schema.secret.id, params.id)).returning({ id: schema.secret.id })
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
