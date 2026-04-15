// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI. REST API routes live in api.ts.
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
import {
  getDb, getAuth, getSession,
  requirePageSession,
  requirePageOrgMember,
  getOrgIdForProject, getOrgIdForEnvironment,
  requireSecretsApiAuth,
  deriveSecrets,
  deriveAllSecretNames,
  decrypt,
} from './db.ts'
import { apiApp } from './api.ts'
import { formatTime } from 'sigillo-app/src/lib/utils'
import { Sidebar, NewProjectButton, FooterColo } from 'sigillo-app/src/components/sidebar'
import { ProjectPage } from 'sigillo-app/src/components/project-page'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from 'sigillo-app/src/components/ui/table'
import { Frame } from 'sigillo-app/src/components/ui/frame'

export { SecretsStore } from './secrets-store.ts'

// Only allow local paths for redirects — prevents open redirect attacks
// on /login?redirect=https://evil.example
function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  return value
}

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
        <body className="relative flex flex-col min-h-screen bg-background font-sans antialiased">
          <ProgressBar />
          <Navbar />
          <div className="border-t border-border" />
          {children ?? (
            <div className="max-w-(--content-max-width) mx-auto w-full border-x border-border flex items-center justify-center text-muted-foreground py-12">
              Page not found
            </div>
          )}
          <Footer />
        </body>
      </html>
    )
  })

  // ── Layout 2: App shell with sidebar ──────────────────────────
  .layout('/orgs/:orgId/projects/:projectId/*', async ({ children, params, request }) => {
    const { orgId, projectId } = params
    const db = getDb()
    const url = new URL(request.url)

    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, orgId)

    // Verify projectId actually belongs to this org — prevents cross-org
    // access via crafted URLs like /orgs/<org-a>/projects/<project-from-org-b>/*
    const realOrgId = await getOrgIdForProject(projectId)
    if (realOrgId !== orgId) throw redirect('/')

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
    const projects = allProjects.map((p) => {
      const sortedEnvs = [...(p.environments || [])].sort((a, b) => a.createdAt - b.createdAt)
      return { id: p.id, name: p.name, firstEnvId: sortedEnvs[0]?.id ?? null }
    })
    const user = { name: session.user.name || 'User', email: session.user.email || '' }

    return (
      <>
        <TabBar orgId={orgId} projectId={projectId} pathname={url.pathname} />
        <div className="border-t border-border" />
        <div className="isolate relative flex max-w-(--content-max-width) mx-auto w-full border-x border-border">
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
      </>
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
        with: { environments: true },
        orderBy: { createdAt: 'desc' },
      })
      if (projects[0]) {
        const sortedEnvs = [...(projects[0].environments || [])].sort((a, b) => a.createdAt - b.createdAt)
        const envSuffix = sortedEnvs[0] ? `/envs/${sortedEnvs[0].id}` : ''
        return Response.redirect(new URL(`/orgs/${params.orgId}/projects/${projects[0].id}${envSuffix}`, base).toString(), 302)
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
      <ContentFrame>
        <div className="isolate relative flex min-h-[min(400px,100vh)]">
          <Sidebar orgs={orgs} projects={[]} currentOrgId={params.orgId} currentProjectId={null} user={user} />
          <main className="flex-1 p-6 overflow-auto">
            <div className="max-w-3xl">
              <h1 className="text-2xl font-bold tracking-tight mb-2">No projects yet</h1>
              <p className="text-muted-foreground mb-6">Create your first project to start managing secrets.</p>
              <NewProjectButton orgId={params.orgId} />
            </div>
          </main>
        </div>
      </ContentFrame>
    )
  })

  // ── New Organization page (standalone, no sidebar) ─────────────
  .page('/new-org', async ({ request }) => {
    await requirePageSession(request)
    return (
      <ContentFrame>
        <div className="max-w-md mx-auto py-12">
          <h1 className="text-2xl font-bold tracking-tight mb-2">New Organization</h1>
          <p className="text-muted-foreground mb-6">
            Organizations group your projects and team members.
          </p>
          <CreateOrgForm />
        </div>
      </ContentFrame>
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

    // Derive current secrets from the event log and decrypt values
    let secrets: { id: string; name: string; value: string; createdAt: number; updatedAt: number; createdBy: { id: string; name: string } | null }[] = []
    // Collect all secret names across all environments for cross-env missing key detection
    const allSecretNames = await deriveAllSecretNames(environments.map((e) => e.id))
    if (selectedEnvId) {
      const derived = await deriveSecrets(selectedEnvId)
      // Look up user info for each secret's latest event author
      const userIds = [...new Set(derived.map((d) => d.userId).filter((userId): userId is string => userId != null))]
      const userMap = new Map<string, { id: string; name: string }>()
      for (const uid of userIds) {
        const u = await db.query.user.findFirst({
          where: { id: uid },
          columns: { id: true, name: true },
        })
        if (u) userMap.set(uid, u)
      }
      secrets = await Promise.all(derived.map(async (d) => ({
        id: d.id, name: d.name,
        value: await decrypt(d.valueEncrypted, d.iv),
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        createdBy: d.userId ? (userMap.get(d.userId) ?? null) : null,
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
          allSecretNames={allSecretNames}
        />
      </div>
    )
  })

  .page('/orgs/:orgId/projects/:projectId/environments', async ({ params }) => {
    const db = getDb()
    const { projectId } = params

    const [project, environments] = await Promise.all([
      db.query.project.findFirst({ where: { id: projectId }, columns: { name: true } }),
      db.query.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    ])

    const { EnvironmentsTable } = await import('sigillo-app/src/components/environments-table')

    return (
      <div className="flex flex-col gap-3 w-full">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{project?.name ?? 'Project'}</h1>
        </div>
        <EnvironmentsTable environments={environments} projectId={projectId} />
      </div>
    )
  })

  // ── Access page (read-only org members table) ─────────────────
  .page('/orgs/:orgId/projects/:projectId/access', async ({ params }) => {
    const db = getDb()
    const { orgId, projectId } = params

    const project = await db.query.project.findFirst({
      where: { id: projectId },
      columns: { name: true },
    })

    const members = await db.query.orgMember.findMany({
      where: { orgId },
      with: { user: { columns: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: 'asc' },
    })

    const { InviteButton } = await import('sigillo-app/src/components/invite-dialog')

    return (
      <div className="flex flex-col gap-3 w-full">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">{project?.name ?? 'Project'}</h1>
          <InviteButton orgId={orgId} />
        </div>
        <Frame className="w-full">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-1/4" />
              <col className="w-1/3" />
              <col className="w-28" />
              <col className="w-32" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {m.user?.image ? (
                        <img src={m.user.image} alt="" className="size-6 rounded-full object-cover" />
                      ) : (
                        <div className="size-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {(m.user?.name || '?').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-sm font-medium">{m.user?.name || '—'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{m.user?.email || '—'}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-xs font-medium capitalize">{m.role}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatTime(m.createdAt)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Frame>
      </div>
    )
  })

  // ── Event Log page ─────────────────────────────────────────────
  .get('/orgs/:orgId/projects/:projectId/event-log', async ({ params }) => {
    const db = getDb()
    const environments = await db.query.environment.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    })
    const firstEnvId = environments[0]?.id || '_'
    return redirect(`/orgs/${params.orgId}/projects/${params.projectId}/envs/${firstEnvId}/event-log`)
  })

  .page('/orgs/:orgId/projects/:projectId/envs/:envId/event-log', async ({ params }) => {
    const db = getDb()
    const { orgId, projectId, envId } = params

    const [project, environments] = await Promise.all([
      db.query.project.findFirst({ where: { id: projectId }, columns: { name: true } }),
      db.query.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    ])

    const selectedEnvId = environments.some((environment) => environment.id === envId)
      ? envId
      : environments[0]?.id || null

    if (selectedEnvId && selectedEnvId !== envId) {
      return redirect(`/orgs/${orgId}/projects/${projectId}/envs/${selectedEnvId}/event-log`)
    }

    // Load events for selected env, sorted by createdAt DESC
    let events: { id: string; name: string; operation: string; valueEncrypted: string | null; iv: string | null; createdAt: number; environmentName: string; userName: string }[] = []
    if (selectedEnvId) {
      const envMap = new Map(environments.map((e) => [e.id, e.name]))
      const rows = await db.query.secretEvent.findMany({
        where: { environmentId: selectedEnvId },
        with: {
          user: { columns: { id: true, name: true } },
          apiToken: { columns: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
      events = rows.map((r) => ({
        id: r.id,
        name: r.name,
        operation: r.operation,
        valueEncrypted: r.valueEncrypted,
        iv: r.iv,
        createdAt: r.createdAt,
        environmentName: envMap.get(r.environmentId) ?? '—',
        userName: r.user?.name ?? r.apiToken?.name ?? '—',
      }))
    }

    // Decrypt values for "set" events so the client can show/hide them
    const eventsWithValues = await Promise.all(events.map(async (evt) => {
      let value: string | null = null
      if (evt.operation === 'set' && evt.valueEncrypted && evt.iv) {
        value = await decrypt(evt.valueEncrypted, evt.iv)
      }
      return { ...evt, value, valueEncrypted: undefined, iv: undefined }
    }))

    const { EventLogTable } = await import('sigillo-app/src/components/event-log-table')

    return (
      <div className="flex flex-col gap-3 w-full">
        <EventLogTable
          projectName={project?.name ?? 'Project'}
          events={eventsWithValues}
          environments={environments}
          selectedEnvId={selectedEnvId}
          orgId={orgId}
          projectId={projectId}
        />
      </div>
    )
  })

  // ── Tokens page ────────────────────────────────────────────────────
  .page('/orgs/:orgId/projects/:projectId/tokens', async ({ params }) => {
    const db = getDb()
    const { orgId, projectId } = params

    const [project, environments, tokens] = await Promise.all([
      db.query.project.findFirst({ where: { id: projectId }, columns: { name: true } }),
      db.query.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      db.query.apiToken.findMany({
        where: { projectId },
        with: {
          creator: { columns: { id: true, name: true } },
          environment: { columns: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    const { TokensPage } = await import('sigillo-app/src/components/tokens-page')

    return (
      <div className="flex flex-col gap-3 w-full">
        <TokensPage
          projectName={project?.name ?? 'Project'}
          projectId={projectId}
          orgId={orgId}
          environments={environments}
          tokens={tokens.map((t) => ({
            id: t.id,
            name: t.name,
            prefix: t.prefix,
            environmentId: t.environmentId,
            environmentName: t.environment?.name ?? null,
            createdBy: t.creator?.name ?? '—',
            createdAt: t.createdAt,
          }))}
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
    return <ContentFrame><DeviceFlow /></ContentFrame>
  })

  // ── Login page (standalone, no sidebar) ─────────────────────────
  .page('/login', async ({ request }) => {
    const session = await getSession(request.headers)
    const url = new URL(request.url)
    const redirectTo = safeRedirectPath(url.searchParams.get('redirect'))
    if (session) return redirect(redirectTo)
    const { LoginButton } = await import('sigillo-app/src/components/login-button')
    return (
      <ContentFrame className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold tracking-tight mb-2">Sigillo</h1>
          <p className="text-muted-foreground mb-6">Sign in to manage your secrets</p>
          <LoginButton callbackURL={redirectTo} />
        </div>
      </ContentFrame>
    )
  })

  // ── Invite accept page (standalone, no sidebar) ────────────────
  .page('/invite/:id', async ({ params, request }) => {
    const db = getDb()
    const invite = await db.query.orgInvitation.findFirst({
      where: { id: params.id },
      with: { org: { columns: { id: true, name: true } }, creator: { columns: { name: true } } },
    })
    if (!invite || invite.expiresAt < Date.now()) {
      return (
        <ContentFrame className="flex justify-center items-center min-h-[60vh]">
          <div className="text-center max-w-sm">
            <h1 className="text-2xl font-bold tracking-tight mb-2">Invalid Invitation</h1>
            <p className="text-muted-foreground">This invitation link is invalid or has expired.</p>
          </div>
        </ContentFrame>
      )
    }
    const session = await getSession(request.headers)
    if (!session) return redirect(`/login?redirect=/invite/${params.id}`)
    // Already a member? Skip straight to the org
    const existing = await db.query.orgMember.findFirst({
      where: { orgId: invite.orgId, userId: session.userId },
    })
    if (existing) return redirect(`/orgs/${invite.orgId}`)
    const { AcceptInviteButton } = await import('sigillo-app/src/components/accept-invite-button')
    return (
      <ContentFrame className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm space-y-4">
          <h1 className="text-2xl font-bold tracking-tight">Join {invite.org!.name}</h1>
          <p className="text-muted-foreground text-sm">
            <span className="font-medium text-foreground">{invite.creator!.name}</span> invited you to join this organization.
          </p>
          <p className="text-muted-foreground text-xs">
            This will give you access to <strong>all projects</strong> in this organization.
          </p>
          <AcceptInviteButton invitationId={params.id} />
        </div>
      </ContentFrame>
    )
  })

  // ── REST API (separate sub-app) ─────────────────────────────────
  .use(apiApp)

function SigilloLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 468 218" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0 C4.335 3.355 6.883 7.639 8 13 C9.277 25.766 2.884 37.172 -3 48 C-3.593 49.101 -4.186 50.202 -4.797 51.336 C-8.601 58.124 -13.004 64.052 -18 70 C-18.7 70.873 -19.4 71.745 -20.121 72.645 C-24.59 78.213 -29.245 83.548 -34.104 88.774 C-36.673 91.538 -39.159 94.342 -41.562 97.25 C-42.367 98.157 -43.171 99.065 -44 100 C-44.66 100 -45.32 100 -46 100 C-45.391 112.982 -45.391 112.982 -42 118 C-38.424 119.788 -34.781 118.933 -31 118 C-22.904 114.2 -16.309 107.212 -10 101 C-9.646 100.669 -9.646 100.669 -7.855 98.992 C-2.139 92.839 -1.024 85.183 0.773 77.242 C5.778 55.255 15.062 33.461 28 15 C28.639 14.087 29.279 13.175 29.938 12.234 C34.62 5.921 39.928 -0.517 48 -2 C54.058 -2 57.045 -0.751 61.555 3.234 C65.511 8.067 65.486 13.351 65.371 19.344 C62.454 48.085 35.794 80.732 14.18 98.496 C12.333 100.851 12.64 102.941 12.688 105.875 C12.691 106.904 12.695 107.932 12.699 108.992 C13.008 112.077 13.57 114.255 15 117 C18.709 119.473 20.282 119.265 24.547 118.652 C40.555 114.396 52.902 95.538 61.75 82.562 C68.185 73.29 76.163 66.704 87.25 63.625 C96.6 62.067 96.6 62.067 101 65 C101 65.66 101 66.32 101 67 C101.443 67.124 101.443 67.124 103.688 67.75 C109.822 70.065 112.465 73.254 115.203 79 C118.471 87.203 117.017 96.212 113.812 104.25 C108.179 116.484 99.676 127.874 86.688 132.75 C79.099 135.051 73.104 134.69 65.996 131.117 C59.421 127.437 56.585 122.455 53 116 C52.441 116.557 51.881 117.114 51.305 117.688 C46.4 122.355 41.555 126.148 35.688 129.5 C35.101 129.838 34.515 130.175 33.912 130.523 C26.994 134.342 20.155 135.031 12.5 133 C7.193 131.062 3.993 127.721 1 123 C-0.282 120.053 -1.241 117.121 -2 114 C-2.427 114.401 -2.853 114.802 -3.293 115.215 C-13.513 124.508 -25.447 134.529 -39.891 134.203 C-45.669 133.647 -49.719 131.694 -53.75 127.5 C-57.532 122.861 -59.318 117.684 -61 112 C-61.378 112.412 -61.755 112.825 -62.145 113.25 C-71.179 122.729 -83.236 132.349 -96.75 133.25 C-102.08 133.141 -106.69 132.024 -110.766 128.453 C-116.057 122.648 -117.481 117.065 -117.312 109.305 C-116.372 99.357 -113.448 89.678 -110.062 80.312 C-109.834 79.666 -109.606 79.019 -109.371 78.353 C-107.601 73.709 -105.42 70.527 -102 67 C-98.558 66.368 -96.819 66.602 -93.688 68.125 C-91.251 70.832 -91.161 72.325 -91 76 C-91.99 79.735 -93.392 83.285 -94.812 86.875 C-101.327 103.725 -101.327 103.725 -101.188 110.875 C-101.181 111.615 -101.175 112.355 -101.168 113.117 C-101 115 -101 115 -100 117 C-91.726 117.657 -86.876 116.037 -80.466 110.73 C-76.497 107.303 -72.723 103.691 -69 100 C-68.174 99.187 -67.347 98.373 -66.496 97.535 C-60.083 90.815 -58.381 83.568 -56.011 74.76 C-49.281 49.979 -38.148 13.955 -14.91 -0.047 C-9.667 -2.663 -5.386 -1.977 0 0 Z M-9 13 C-23.35 25.332 -31.41 46.18 -37.688 63.625 C-37.944 64.329 -38.2 65.033 -38.463 65.759 C-40.127 70.62 -40.127 70.62 -39 74 C-5.944 36.248 -5.944 36.248 -5.75 16.812 C-5.832 15.884 -5.915 14.956 -6 14 C-6.99 13.67 -7.98 13.34 -9 13 Z M49 13 C33.78 24.854 25.607 47.066 19.25 64.75 C18.998 65.446 18.745 66.143 18.486 66.861 C16.871 71.614 16.871 71.614 18 75 C30.273 61.342 51.8 37.208 51.125 17.625 C51.084 16.429 51.043 15.233 51 14 C50.34 13.67 49.68 13.34 49 13 Z M76 89 C71.083 95.609 67.49 101.59 67.668 110.035 C68.281 113.661 70.442 116.442 73 119 C80.104 119.612 84.236 117.964 89.781 113.598 C96.211 107.831 100.718 99.683 102.062 91.125 C102.275 87.083 101.307 84.378 99 81 C90.263 75.175 81.812 82.27 76 89 Z " transform="translate(338,7)" />
      <path d="M0 0 C2.438 1.5 2.438 1.5 4 4 C4.62 7.131 4.636 9.87 4 13 C1.455 16.702 -0.189 17.768 -4.5 19 C-8.443 19 -9.988 18.495 -13 16 C-15.069 13.366 -14.999 11.962 -14.938 8.562 C-13.829 4.352 -12.314 2.748 -9 0 C-5.815 -1.593 -3.398 -0.762 0 0 Z " transform="translate(116,42)" />
      <path d="M0 0 C2.932 2.083 3.823 3.458 4.938 6.875 C5.016 10.809 4.175 12.738 2 16 C-0.323 18.058 -1.868 18.967 -4.996 19.059 C-7.901 18.808 -10.401 18.348 -12.938 16.875 C-14.631 13.886 -14.884 11.418 -15 8 C-13.765 4.432 -12.607 2.522 -9.75 0.062 C-6.04 -1.371 -3.813 -1.04 0 0 Z " transform="translate(255,42)" />
      <path d="M0 0 C3.614 2.711 6.457 5.79 8.5 9.875 C8.908 14.743 9.07 19.322 7.375 23.938 C4.866 26.53 3.06 27.305 -0.5 27.875 C-2.89 26.76 -4.64 25.735 -6.5 23.875 C-6.572 22.189 -6.584 20.5 -6.562 18.812 C-6.553 17.893 -6.544 16.974 -6.535 16.027 C-6.524 15.317 -6.512 14.607 -6.5 13.875 C-16.022 13.065 -24.236 18.025 -31.5 23.875 C-34.5 27.875 -34.5 27.875 -34.5 30.875 C-29.979 32.4 -25.454 33.899 -20.895 35.305 C-19.367 35.786 -17.84 36.268 -16.312 36.75 C-15.929 36.865 -15.929 36.865 -13.986 37.449 C-8.113 39.331 -3.335 41.706 -0.125 47.25 C0.963 51.82 0.984 55.48 -0.562 59.938 C-4.748 66.284 -10.167 69.97 -17.5 71.875 C-29.111 74.172 -40.517 73.811 -50.938 67.938 C-54.536 65.041 -56.303 63.488 -56.875 58.812 C-56.5 55.875 -56.5 55.875 -55.375 54 C-52.533 52.295 -50.775 52.434 -47.5 52.875 C-45.051 54.052 -42.825 55.454 -40.5 56.875 C-32.502 59.524 -23.978 58.326 -16.5 54.875 C-16.5 54.215 -16.5 53.555 -16.5 52.875 C-17.119 52.664 -17.739 52.453 -18.377 52.236 C-21.235 51.254 -24.086 50.252 -26.938 49.25 C-27.911 48.919 -28.885 48.587 -29.889 48.246 C-37.34 45.605 -44.895 42.586 -49.562 35.938 C-51.023 31.166 -51.249 27.578 -49.219 22.961 C-42.926 11.662 -31.349 2.821 -18.887 -0.727 C-12.529 -1.788 -6.162 -1.981 0 0 Z " transform="translate(65.5,70.125)" />
      <path d="M0 0 C0.298 0.18 0.298 0.18 1.809 1.09 C2.819 1.667 3.83 2.245 4.871 2.84 C5.51 3.252 6.15 3.665 6.809 4.09 C6.932 3.78 6.932 3.78 7.559 2.215 C9.082 -0.376 9.943 -1.035 12.809 -1.91 C15.894 -1.721 18.067 -1.341 20.746 0.215 C22.659 3.591 21.269 7.416 20.277 11.023 C19.624 13.103 18.934 15.165 18.227 17.227 C18.099 17.607 18.099 17.607 17.452 19.532 C16.639 21.949 15.818 24.363 14.996 26.777 C14.456 28.378 13.916 29.979 13.377 31.58 C12.337 34.667 11.294 37.753 10.248 40.837 C8.414 46.248 6.608 51.668 4.809 57.09 C5.558 56.755 6.306 56.42 7.078 56.074 C10.673 54.778 13.121 55.255 16.809 56.09 C18.809 58.09 18.809 58.09 19.121 61.527 C18.809 65.09 18.809 65.09 17.754 66.727 C15.396 68.379 13.256 68.536 10.465 69.012 C6.261 69.922 3.039 71.184 -0.191 74.09 C-5.046 81.847 -7.745 90.758 -10.766 99.342 C-14.04 108.249 -18.506 116.943 -24.129 124.59 C-24.55 125.17 -24.971 125.751 -25.405 126.349 C-29.999 132.474 -34.929 136.625 -42.191 139.09 C-49.278 140.001 -55.353 139.376 -61.191 135.09 C-65.302 131.451 -67.275 127.494 -68.191 122.09 C-68.576 109.953 -61.005 100.615 -53.191 92.09 C-42.622 81.073 -28.943 71.727 -15.191 65.09 C-14.531 65.09 -13.871 65.09 -13.191 65.09 C-12.923 63.811 -12.655 62.532 -12.379 61.215 C-11.246 56.089 -9.759 51.097 -8.191 46.09 C-8.797 46.67 -9.403 47.25 -10.027 47.848 C-18.608 55.847 -28.806 64.223 -41.191 64.09 C-46.011 63.269 -49.884 61.912 -53.129 58.152 C-57.191 52.12 -57.191 52.12 -57.191 47.09 C-57.786 47.586 -58.38 48.082 -58.992 48.594 C-80.13 65.918 -80.13 65.918 -93.734 65.438 C-99.176 64.668 -103.398 62.279 -107.066 58.215 C-112.341 50.458 -112.146 42.331 -110.504 33.316 C-108.008 22.221 -104.661 9.54 -98.191 0.09 C-95.351 -1.331 -93.337 -1.225 -90.191 -0.91 C-87.816 0.652 -87.816 0.652 -86.191 3.09 C-85.544 9.372 -87.386 14.26 -89.566 20.027 C-95.514 36.069 -95.514 36.069 -95.379 42.965 C-95.372 43.705 -95.366 44.445 -95.359 45.207 C-95.191 47.09 -95.191 47.09 -94.191 49.09 C-86.103 49.873 -81.613 47.974 -75.191 43.09 C-71.043 39.564 -67.099 35.879 -63.191 32.09 C-62.435 31.362 -61.678 30.633 -60.898 29.883 C-55.654 24.74 -50.82 19.269 -46.141 13.609 C-34.73 0.213 -17.222 -9.148 0 0 Z M-33.852 21.32 C-38.564 26.898 -42.879 33.997 -43.441 41.367 C-43.142 44.629 -42.673 45.939 -40.191 48.09 C-36.182 49.068 -33.35 47.931 -29.816 46.09 C-19.324 39.425 -8.804 28.642 -2.191 18.09 C-2.191 16.09 -2.191 16.09 -4.129 14.027 C-14.839 7.252 -25.628 13.486 -33.852 21.32 Z M-22.191 85.09 C-48.736 103.611 -48.736 103.611 -53.191 118.09 C-52.96 121.559 -52.662 122.62 -50.191 125.09 C-44.947 125.215 -41.92 122.846 -38.266 119.414 C-32.024 112.42 -27.938 103.952 -24.129 95.465 C-23.818 94.778 -23.506 94.091 -23.185 93.383 C-21.068 88.459 -21.068 88.459 -22.191 85.09 Z " transform="translate(193.19140625,74.91015625)" />
    </svg>
  )
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  )
}

function TabBar({ orgId, projectId, pathname }: { orgId: string; projectId: string; pathname: string }) {
  const base = `/orgs/${orgId}/projects/${projectId}`
  const envMatch = pathname.match(new RegExp(`^${base}/envs/([^/]+)`))
  const currentEnvBase = envMatch ? `${base}/envs/${envMatch[1]}` : null
  const tabs = [
    { label: 'Secrets', href: currentEnvBase || base, active: pathname === base || (pathname.startsWith(`${base}/envs`) && !pathname.endsWith('/event-log')) },
    { label: 'Environments', href: `${base}/environments`, active: pathname === `${base}/environments` },
    { label: 'Tokens', href: `${base}/tokens`, active: pathname === `${base}/tokens` },
    { label: 'Access', href: `${base}/access`, active: pathname === `${base}/access` },
    {
      label: 'Event Log',
      href: currentEnvBase ? `${currentEnvBase}/event-log` : `${base}/event-log`,
      active: pathname === `${base}/event-log` || pathname.endsWith('/event-log'),
    },
  ] as const

  return (
    <div className="max-w-(--content-max-width) mx-auto w-full border-x border-border">
      <div className="flex h-10 items-stretch gap-6 px-6">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={`relative flex items-center text-sm no-underline transition-colors duration-150 ${
              tab.active
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
            {tab.active && (
              <div className="absolute bottom-0 left-0 w-full h-[1.5px] bg-primary rounded-sm" />
            )}
          </Link>
        ))}
      </div>
    </div>
  )
}

function ContentFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`max-w-(--content-max-width) mx-auto w-full border-x border-border ${className ?? ''}`}>
      {children}
    </div>
  )
}

function Navbar() {
  return (
    <nav className="sticky top-0 z-50 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="max-w-(--content-max-width) mx-auto border-x border-border">
        <div className="flex h-14 items-center justify-between px-6">
          <Link href="/" className="text-primary hover:opacity-80 transition-opacity">
            <SigilloLogo className="h-[36px] w-auto shrink-0" />
          </Link>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/remorses/sigillo/issues/new"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              feedback
            </a>
            <a
              href="https://github.com/remorses/sigillo"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              github
            </a>
          </div>
        </div>
      </div>
    </nav>
  )
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function Footer() {
  return (
    <footer className="flex-1 flex flex-col justify-stretch">
      <div className="border-t border-border" />
      <div className="max-w-(--content-max-width) grow mx-auto w-full border-x border-border">
        <div className="flex items-center justify-end gap-4 px-6 py-4">
          <FooterColo />
          <span className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Sigillo
          </span>
          <a
            href="https://github.com/remorses/sigillo"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <GitHubIcon className="size-4" />
          </a>
          <a
            href="https://x.com/__morse"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <XIcon className="size-3.5" />
          </a>
        </div>
      </div>
    </footer>
  )
}

export type App = typeof app

export default {
  async fetch(request: Request): Promise<Response> {
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>
