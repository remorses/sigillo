// Spiceflow entry for the self-hosted secret sharing app.
// Pages for secrets management UI. REST API routes live in api.ts.
// Also serves as the Cloudflare Worker entry via the default export.
//
// Two nested layouts:
// 1. /* — HTML shell (head, body, fonts, ProgressBar)
// 2. /dash/* — Authenticated app shell with sidebar
//
// Standalone pages (no sidebar): /, /login, /device, /invite/:id

import './globals.css'
import { Spiceflow } from 'spiceflow'
import { Head, Link, ProgressBar, router } from 'spiceflow/react'
import { env } from 'cloudflare:workers'
import { initStrada, trace } from '@strada.sh/sdk'
import {
  getDb, getAuth, getSession, getRequestOrigin, ensureOAuthClient,
  requirePageSession,
  requirePageOrgMember,
  getOrgIdForProject,
  deriveEnvironmentSecretsAndNames,
  decrypt,
  autoJoinOrgsByDomain,
  getAccessibleProjectIds,
  getEnvironmentAccessError,
  getProjectMemberAccess,
  listUserSessions,
} from './db.ts'
import { apiApp } from './api.ts'
import { rememberCacheOrigin } from './lib/memoize.ts'
import { cn } from 'sigillo-app/src/lib/utils'
import { CreateOrgForm } from 'sigillo-app/src/components/create-org-form'
import { SigilloLogo } from 'sigillo-app/src/components/logo'
import { app as holocronApp } from '@holocron.so/vite/app'


const cliBannerCookieName = 'sigillo-cli-banner-dismissed'

function isTruthy<T>(value: T | null | undefined): value is T {
  return value != null
}

// Only allow local app paths for redirects — prevents open redirects and
// avoids sending logged-in users to API routes or obvious 404s.
function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/dash'
  if (['/', '/device'].includes(value)) return value
  if (value === '/dash' || value.startsWith('/dash/') || value.startsWith('/invite/')) return value
  return '/'
}

function hasCookie(args: { cookieHeader: string; name: string }) {
  return args.cookieHeader
    .split(';')
    .some((part) => part.trim().startsWith(`${args.name}=`))
}

// Strada observability (strada.sh). trace.getTracer returns a proxy that
// delegates to the provider registered by initStrada() in the fetch handler,
// so module-level creation is safe. Self-hosted instances have no
// STRADA_PROJECT_ID binding → tracer stays a noop and zero requests are made.
const tracer = trace.getTracer('sigillo-app')

export const app = new Spiceflow({ tracer })

  // ── BetterAuth middleware ──────────────────────────────────────
  // BetterAuth runs in the worker, not the DO. Only SQL crosses the
  // DO boundary via sqlite-proxy.
  .use(async ({ request }, next) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/auth')) {
      const auth = await getAuth(request)
      const res = await auth.handler(request)
      if (res.ok || res.status !== 404) return res
    }
    return next()
  })

  // ── Layout: Dashboard routes (HTML shell + sidebar chrome) ──────
  // No global layout('/*') because holocron provides its own HTML shell
  // for docs pages (/). Each route group registers AppShell separately.
  .layout('/dash/*', async ({ children, request }) => {
    const { MobileMenuButton } = await import('sigillo-app/src/components/sidebar')
    return (
      <AppShell request={request} mobileMenuSlot={<MobileMenuButton />}>
        {children}
      </AppShell>
    )
  })

  // ── Layout: Standalone pages (login, device, invite, new-org) ──
  .layout('/login', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)
  .layout('/device', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)
  .layout('/invite/*', async ({ children, request }) => <AppShell request={request}>{children}</AppShell>)

  .loader('/dash/*', async ({ request }) => {
    const db = getDb()
    const pathname = new URL(request.url).pathname
    const projectId = new URLPattern({ pathname: '/dash/projects/:projectId/*' })
      .exec(request.url)?.pathname.groups.projectId ?? null
    const session = await requirePageSession(request)
    // Auto-join orgs by email domain before querying memberships.
    // Uses waitUntil so the page doesn't block on the insert if it's slow,
    // but we await it here because the membership list below needs to include
    // any newly joined orgs for correct sidebar rendering.
    await autoJoinOrgsByDomain(session)
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })

    const orgs = members.filter((m) => m.org != null).map((m) => ({
      id: m.org!.id!, name: m.org!.name!, role: m.role,
      createdAt: m.org!.createdAt!, updatedAt: m.org!.updatedAt!,
    }))

    return {
      orgs,
      projectId,
      pathname,
      currentProjectFirstEnvSlug: null,
      user: { name: session.user.name || 'User', email: session.user.email || '' },
    }
  })

  .loader('/dash/orgs/:orgId', async ({ params, request }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)

    const accessibleIds = await getAccessibleProjectIds(session.userId, params.orgId)
    const allProjects = await db.query.project.findMany({
      where: { orgId: params.orgId },
      with: { environments: true },
      orderBy: { createdAt: 'desc' },
    })

    const projects = allProjects
      .filter((p) => accessibleIds === null || accessibleIds.includes(p.id))
      .map((p) => {
        const sortedEnvs = [...(p.environments || [])].sort((a, b) => a.createdAt - b.createdAt)
        return { id: p.id, name: p.name, firstEnvSlug: sortedEnvs[0]?.slug ?? null }
      })

    return {
      orgId: params.orgId,
      projectId: null,
      projects,
      environments: [],
      currentProjectFirstEnvSlug: null,
    }
  })

  .loader('/dash/projects/:projectId/*', async ({ params, request }) => {
    const db = getDb()
    const url = new URL(request.url)
    const { projectId } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw Response.redirect(new URL('/', request.url).toString(), 302)

    // One access lookup covers org membership ([] for non-members), the
    // current-project check, AND the sidebar project filter — previously
    // three sequential round-trips. Run it in parallel with the project list.
    const [accessibleIds, allProjects] = await Promise.all([
      getAccessibleProjectIds(session.userId, orgId),
      db.query.project.findMany({
        where: { orgId },
        with: { environments: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    if (accessibleIds !== null && !accessibleIds.includes(projectId)) {
      throw Response.redirect(new URL('/', request.url).toString(), 302)
    }

    const projects = allProjects
      .filter((p) => accessibleIds === null || accessibleIds.includes(p.id))
      .map((p) => {
        const sortedEnvs = [...(p.environments || [])].sort((a, b) => a.createdAt - b.createdAt)
        return { id: p.id, name: p.name, firstEnvSlug: sortedEnvs[0]?.slug ?? null }
      })
    const currentProject = allProjects.find((project) => project.id === projectId)
    const environments = [...(currentProject?.environments || [])].sort((a, b) => a.createdAt - b.createdAt)

    return {
      orgId,
      projectId,
      projectName: currentProject?.name ?? 'Project',
      pathname: url.pathname,
      projects,
      environments,
      currentProjectFirstEnvSlug: projects.find((project) => project.id === projectId)?.firstEnvSlug ?? null,
    }
  })

  // ── Layout 2: Authenticated app shell with sidebar ─────────────
  .layout('/dash/*', async ({ children, loaderData }) => {
    const { Sidebar, MobileDrawer } = await import('sigillo-app/src/components/sidebar')
    const projectId = loaderData.projectId
    return (
      <>
        {projectId && (
          <>
            <TabBar
              projectId={projectId}
              pathname={loaderData.pathname}
              firstEnvSlug={loaderData.currentProjectFirstEnvSlug}
            />
            <div className="border-t border-border" />
          </>
        )}
        <div className="isolate min-h-0 grow relative flex max-w-(--content-max-width) mx-auto w-full border-x border-border">
          <GridDot position="tl" />
          <GridDot position="tr" />
          <Sidebar />
          <MobileDrawer />
          <main className="flex-1 p-4 sm:p-6 overflow-x-hidden overflow-y-auto min-w-0">
            {children}
          </main>
        </div>
      </>
    )
  })

  // ── /dash redirect → resolve user's default project+env in one hop ──
  // The holocron navbar links to /dash. This resolves the full path
  // (org → project → env) in a single worker invocation instead of
  // chaining through /dash/orgs/:orgId → /dash/projects/:id → /envs/:slug.
  .get('/dash', async ({ request }) => {
    const session = await getSession(request)
    if (!session) return Response.redirect(new URL('/login?redirect=/dash', request.url).toString(), 302)
    const db = getDb()
    const members = await db.query.orgMember.findMany({
      where: { userId: session.userId },
      with: { org: true },
    })
    const lastOrg = members
      .filter((m) => m.org != null)
      .sort((a, b) => b.org!.createdAt! - a.org!.createdAt!)
      [0]
    if (!lastOrg) {
      return Response.redirect(new URL('/dash/new-org', request.url).toString(), 302)
    }
    const firstProject = await db.query.project.findFirst({
      where: { orgId: lastOrg.org!.id },
      columns: { id: true },
      with: { environments: { columns: { slug: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    if (firstProject) {
      const sortedEnvs = [...(firstProject.environments || [])].sort((a, b) => a.createdAt - b.createdAt)
      const envSlug = sortedEnvs[0]?.slug ?? '_'
      const href = `/dash/projects/${encodeURIComponent(firstProject.id)}/envs/${encodeURIComponent(envSlug)}`
      return Response.redirect(new URL(href, request.url).toString(), 302)
    }
    return Response.redirect(new URL(`/dash/orgs/${encodeURIComponent(lastOrg.org!.id)}`, request.url).toString(), 302)
  })

  // ── Org root redirect → resolve first project+env in one hop ──
  .get('/dash/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()
    const firstProject = await db.query.project.findFirst({
      where: { orgId: params.orgId },
      columns: { id: true },
      with: { environments: { columns: { slug: true, createdAt: true } } },
      orderBy: { createdAt: 'desc' },
    })
    if (firstProject) {
      const sortedEnvs = [...(firstProject.environments || [])].sort((a, b) => a.createdAt - b.createdAt)
      const envSlug = sortedEnvs[0]?.slug ?? '_'
      const href = `/dash/projects/${encodeURIComponent(firstProject.id)}/envs/${encodeURIComponent(envSlug)}`
      return Response.redirect(new URL(href, request.url).toString(), 302)
    }
    return null
  })

  // ── Org page (redirects to first project, or shows empty state) ─
  .page('/dash/orgs/:orgId', async ({ params, request }) => {
    const session = await requirePageSession(request)
    await requirePageOrgMember(session.userId, params.orgId)
    const db = getDb()

    const projects = await db.query.project.findMany({
        where: { orgId: params.orgId },
        orderBy: { createdAt: 'desc' },
      })
    const projectList = projects.map((p) => ({ id: p.id, name: p.name }))

    if (projectList[0]) {
      return Response.redirect(new URL(`/dash/projects/${encodeURIComponent(projectList[0].id)}`, request.url).toString(), 302)
    }

    const { NewProjectButton } = await import('sigillo-app/src/components/sidebar')

    return (
      <div className="max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight mb-2">No projects yet</h1>
        <p className="text-muted-foreground mb-6">Create your first project to start managing secrets.</p>
        <NewProjectButton orgId={params.orgId} />
      </div>
    )
  })

  // ── New Organization page (standalone, no sidebar) ─────────────
  .page('/dash/new-org', async () => {
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
  .page('/dash/projects/:projectId', async ({ params, request, redirect }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(params.projectId)
    if (!orgId) throw Response.redirect(new URL('/', request.url).toString(), 302)
    await requirePageOrgMember(session.userId, orgId)
    const environments = await db.query.environment.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    })
    const firstEnvSlug = environments[0]?.slug || '_'
    throw redirect(`/dash/projects/${encodeURIComponent(params.projectId)}/envs/${encodeURIComponent(firstEnvSlug)}`)
  })

  .loader('/dash/projects/:projectId/envs/:envSlug', async ({ request, params, redirect }) => {
    const db = getDb()
    const { projectId, envSlug } = params
    const session = await requirePageSession(request)

    const environments = await db.query.environment.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    })

    const matchedEnv = environments.find((e) => e.slug === envSlug)
    const selectedEnvId = matchedEnv?.id ?? environments[0]?.id ?? null

    if (selectedEnvId && !matchedEnv && environments[0]) {
      throw redirect(`/dash/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(environments[0].slug)}`)
    }

    // Never decrypt envs the user can't access (admin-only for members).
    // Loaders run in parallel, so don't rely on the parent loader's checks.
    const access = await getProjectMemberAccess(session.userId, projectId)
    const readableEnvIds = environments.filter((e) => !getEnvironmentAccessError(access, e)).map((e) => e.id)
    const locked = !!selectedEnvId && !readableEnvIds.includes(selectedEnvId)

    let secrets: { id: string; name: string; value: string; createdAt: number; updatedAt: number; createdBy: { id: string; name: string } | null }[] = []
    // One D1 batch derives the selected env's secrets AND the union of names
    // across all readable envs, instead of a separate names round-trip.
    const { secrets: derived, allNames: allSecretNames } = await deriveEnvironmentSecretsAndNames({
      environmentIds: readableEnvIds,
      selectedEnvId: locked ? null : selectedEnvId,
    })
    if (selectedEnvId && !locked) {
      // Resolve all secret authors in ONE query instead of findFirst per user.
      const userIds = [...new Set(derived.map((d) => d.userId).filter(isTruthy))]
      const userMap = new Map<string, { id: string; name: string }>()
      if (userIds.length > 0) {
        const users = await db.query.user.findMany({
          where: { id: { in: userIds } },
          columns: { id: true, name: true },
        })
        for (const u of users) userMap.set(u.id, u)
      }
      secrets = await Promise.all(derived.map(async (d) => ({
        id: d.id, name: d.name,
        value: await decrypt(d.valueEncrypted, d.iv),
        createdAt: d.createdAt, updatedAt: d.updatedAt,
        createdBy: d.userId ? (userMap.get(d.userId) ?? null) : null,
      })))
    }

    const cookieHeader = request.headers.get('cookie') ?? ''

    return {
      selectedEnvId,
      locked,
      secrets,
      allSecretNames,
      showBanner: !hasCookie({ cookieHeader, name: cliBannerCookieName }),
    }
  })

  // ── Project detail with env ───────────────────────────────────
  .page('/dash/projects/:projectId/envs/:envSlug', async ({ loaderData }) => {
    const { ProjectPage } = await import('sigillo-app/src/components/project-page')
    return <ProjectPage key={loaderData.selectedEnvId ?? 'none'} />
  })

  .loader('/dash/projects/:projectId/environments', async ({ params }) => {
    return { projectId: params.projectId }
  })

  .page('/dash/projects/:projectId/environments', async () => {
    const { EnvironmentsPage } = await import('sigillo-app/src/components/environments-table')

    return <EnvironmentsPage />
  })

  // ── Access page ────────────────────────────────────────────────
  .loader('/dash/projects/:projectId/access', async ({ params, request, redirect }) => {
    const db = getDb()
    const { projectId } = params
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(projectId)
    if (!orgId) throw redirect('/')
    const { role } = await requirePageOrgMember(session.userId, orgId)

    const [members, orgProjects] = await Promise.all([
      db.query.orgMember.findMany({
        where: { orgId },
        with: {
          user: { columns: { id: true, name: true, email: true, image: true } },
          accessRules: { columns: { projectId: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      db.query.project.findMany({
        where: { orgId },
        columns: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
    ])

    return {
      orgId,
      role,
      currentUserId: session.userId,
      members,
      orgProjects,
    }
  })

  .page('/dash/projects/:projectId/access', async () => {
    const { AccessPage } = await import('sigillo-app/src/components/access-table')

    return <AccessPage />
  })

  // ── Event Log page ─────────────────────────────────────────────
  .get('/dash/projects/:projectId/event-log', async ({ params, redirect }) => {
    const db = getDb()
    const environments = await db.query.environment.findMany({
      where: { projectId: params.projectId },
      orderBy: { createdAt: 'asc' },
    })
    const firstEnvSlug = environments[0]?.slug || '_'
    throw redirect(`/dash/projects/${encodeURIComponent(params.projectId)}/envs/${encodeURIComponent(firstEnvSlug)}/event-log`)
  })

  .loader('/dash/projects/:projectId/envs/:envSlug/event-log', async ({ params, request, redirect }) => {
    const db = getDb()
    const { projectId, envSlug } = params
    const session = await requirePageSession(request)

    const environments = await db.query.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } })

    const matchedEnv = environments.find((e) => e.slug === envSlug)
    const selectedEnvId = matchedEnv?.id ?? environments[0]?.id ?? null

    if (selectedEnvId && !matchedEnv && environments[0]) {
      throw redirect(`/dash/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(environments[0].slug)}/event-log`)
    }

    const access = await getProjectMemberAccess(session.userId, projectId)
    const locked = !!matchedEnv && !!getEnvironmentAccessError(access, matchedEnv)

    // Load events for selected env, sorted by createdAt DESC
    let events: { id: string; name: string; operation: string; valueEncrypted: string | null; iv: string | null; createdAt: number; environmentName: string; userName: string }[] = []
    if (selectedEnvId && !locked) {
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

    return {
      events: eventsWithValues,
      selectedEnvId,
      locked,
      projectId,
    }
  })

  .page('/dash/projects/:projectId/envs/:envSlug/event-log', async () => {
    const { EventLogTable } = await import('sigillo-app/src/components/event-log-table')

    return (
      <div className="flex flex-col gap-3 w-full">
        <EventLogTable />
      </div>
    )
  })

  // ── Your sessions ──────────────────────────────────────────────────
  .loader('/dash/sessions', async ({ request }) => {
    const sessions = await listUserSessions(request)
    return { sessions: sessions ?? [], signInAgain: sessions === null }
  })

  .page('/dash/sessions', async () => {
    const { SessionsPage } = await import('sigillo-app/src/components/sessions-page')
    return (
      <div className="flex flex-col gap-3 w-full">
        <SessionsPage />
      </div>
    )
  })

  // ── Tokens page ────────────────────────────────────────────────────
  .loader('/dash/projects/:projectId/tokens', async ({ params }) => {
    const db = getDb()
    const { projectId } = params

    const tokens = await db.query.apiToken.findMany({
      where: { projectId },
      with: {
        creator: { columns: { id: true, name: true } },
        environments: { with: { environment: { columns: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    })

    return {
      projectId,
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        environmentNames: t.environments
          .map((row) => row.environment?.name)
          .filter((name): name is string => Boolean(name)),
        createdBy: t.creator?.name ?? '—',
        createdAt: t.createdAt,
      })),
    }
  })

  .page('/dash/projects/:projectId/tokens', async () => {
    const { TokensPage } = await import('sigillo-app/src/components/tokens-page')

    return (
      <div className="flex flex-col gap-3 w-full">
        <TokensPage />
      </div>
    )
  })

  // ── Settings page ────────────────────────────────────────────────
  .loader('/dash/projects/:projectId/settings', async ({ params, request, redirect }) => {
    const db = getDb()
    const session = await requirePageSession(request)
    const orgId = await getOrgIdForProject(params.projectId)
    if (!orgId) throw redirect('/')
    await requirePageOrgMember(session.userId, orgId)

    const [orgRow, projects] = await Promise.all([
      db.query.org.findFirst({ where: { id: orgId }, columns: { name: true, autoJoinDomain: true } }),
      db.query.project.findMany({ where: { orgId }, columns: { name: true }, orderBy: { createdAt: 'asc' } }),
    ])

    return {
      orgId,
      orgName: orgRow?.name ?? 'Organization',
      autoJoinDomain: orgRow?.autoJoinDomain ?? null,
      projectNames: projects.map((p) => p.name),
    }
  })

  .page('/dash/projects/:projectId/settings', async () => {
    const { SettingsPage } = await import('sigillo-app/src/components/settings-page')

    return (
      <div className="flex flex-col gap-3 w-full">
        <SettingsPage />
      </div>
    )
  })

  // ── Device flow verification page (standalone, no sidebar) ─────
  // Uses the proper BetterAuth device authorization client flow:
  // 1. Validate code via authClient.device({ query: { user_code } })
  // 2. Approve/deny via authClient.device.approve() / .deny()
  .page('/device', async ({ request }) => {
    // User must be logged in to approve device codes
    const session = await getSession(request)
    if (!session) return Response.redirect(new URL('/login', request.url).toString(), 302)
    const url = new URL(request.url)
    const userCode = url.searchParams.get('user_code') ?? ''
    const { DeviceFlow } = await import('sigillo-app/src/components/device-flow')
    return <ContentFrame><DeviceFlow initialCode={userCode} /></ContentFrame>
  })

  // ── Sign out ────────────────────────────────────────────────────
  // Clears the local session, then hands off to the provider so the SSO
  // session at PROVIDER_URL dies too. Signing out only here is not enough:
  // the provider would still hold a live session and the next sign-in would
  // silently reuse it, making it impossible to switch Google accounts.
  //
  // This is a full navigation (not authClient.signOut() in the browser)
  // because the second half has to be a cross-origin redirect the browser
  // follows, so the provider can set its own expired Set-Cookie.
  .get('/logout', async ({ request }) => {
    const origin = getRequestOrigin(request)
    // "Sign in again" comes back to the page it was on
    const login = new URL('/login', origin)
    const back = new URL(request.url).searchParams.get('redirect')
    if (back) login.searchParams.set('redirect', safeRedirectPath(back))
    const providerSignOut = new URL('/sign-out', env.PROVIDER_URL)
    providerSignOut.searchParams.set('client_id', await ensureOAuthClient(request))
    providerSignOut.searchParams.set('post_logout_redirect_uri', login.toString())

    const res = new Response(null, { status: 302, headers: { Location: providerSignOut.toString() } })

    // signOut throws when there is no session cookie, so only call it when a
    // session actually resolved. Hitting /logout while already signed out is
    // normal and must still forward to the provider.
    if (await getSession(request)) {
      const auth = await getAuth(request)
      const { headers } = await auth.api.signOut({ headers: request.headers, returnHeaders: true })
      for (const cookie of headers.getSetCookie()) res.headers.append('Set-Cookie', cookie)
    }

    return res
  })

  // ── Login page (standalone, no sidebar) ─────────────────────────
  .page('/login', async ({ request, redirect }) => {
    const session = await getSession(request)
    const url = new URL(request.url)
    const redirectTo = safeRedirectPath(url.searchParams.get('redirect'))
    if (session) throw redirect(redirectTo)
    const { LoginButton } = await import('sigillo-app/src/components/login-button')
    return (
      <ContentFrame className="flex grow justify-center items-center">
        <div className="text-center max-w-sm">
          <SigilloLogo className="h-[40px] w-auto mx-auto mb-2" />
          <p className="text-muted-foreground mb-6">Sign in to manage your secrets</p>
          <LoginButton callbackURL={redirectTo} />
        </div>
      </ContentFrame>
    )
  })

  // ── Invite accept page (standalone, no sidebar) ────────────────
  .page('/invite/:id', async ({ params, request, redirect }) => {
    const db = getDb()
    const invite = await db.query.orgInvitation.findFirst({
      where: { id: params.id },
      with: { org: { columns: { id: true, name: true } }, creator: { columns: { name: true } } },
    })
    if (!invite || invite.expiresAt < Date.now()) {
      return (
        <ContentFrame className="flex grow justify-center items-center">
          <div className="text-center max-w-sm">
            <h1 className="text-2xl font-bold tracking-tight mb-2">Invalid Invitation</h1>
            <p className="text-muted-foreground">This invitation link is invalid or has expired.</p>
          </div>
        </ContentFrame>
      )
    }
    const session = await getSession(request)
    if (!session) {
      const redirectPath = `/invite/${encodeURIComponent(params.id)}`
      return Response.redirect(new URL(`/login?redirect=${encodeURIComponent(redirectPath)}`, request.url).toString(), 302)
    }
    // Already a member? Skip straight to the org
    const existing = await db.query.orgMember.findFirst({
      where: { orgId: invite.orgId, userId: session.userId },
    })
    if (existing) throw redirect(`/dash/orgs/${encodeURIComponent(invite.orgId)}`)
    const { AcceptInviteButton } = await import('sigillo-app/src/components/accept-invite-button')
    return (
      <ContentFrame className="flex grow justify-center items-center">
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

  // ── Holocron docs/landing page ────────────────────────────────
  // Mounted last so all explicit routes above take priority.
  // Holocron handles "/" (index.mdx) with its own HTML shell, navbar, and footer.
  .use(holocronApp)

/** Shared HTML shell for all non-holocron pages (dash, login, device, invite).
 *  Holocron provides its own shell for docs routes (/).
 *  This replaces the old global layout('/*'). */
const appThemeScript = `(function(){var d=document.documentElement;var m=document.cookie.match(/(?:^|;\\s*)color-theme=(light|dark)(?:;|$)/);var t=m?m[1]:null;if(!t)t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';if(t==='dark')d.classList.add('dark');else d.classList.remove('dark')})()`

function getInitialThemeClass(request: Request) {
  const cookie = request.headers.get('cookie') ?? ''
  return /(?:^|;\s*)color-theme=dark(?:;|$)/.test(cookie) ? 'dark' : undefined
}

function AppShell({ children, mobileMenuSlot, request }: { children: React.ReactNode; mobileMenuSlot?: React.ReactNode; request: Request }) {
  return (
    <html lang="en" className={cn("h-dvh", getInitialThemeClass(request))} data-default-theme="system" suppressHydrationWarning>
      <Head>
        <Head.Meta charSet="UTF-8" />
        <Head.Meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <Head.Title>Sigillo — Secret Manager</Head.Title>
        <Head.Link rel="icon" type="image/png" href="/favicon.png" />
      </Head>
      <body className="relative flex h-dvh flex-col bg-background font-sans antialiased">
        <StradaShellBrowser />
        <script dangerouslySetInnerHTML={{ __html: appThemeScript }} />
        <ProgressBar color="var(--primary)" />
        <Navbar mobileMenuSlot={mobileMenuSlot} />
        <div className="shrink-0 border-t border-border" />
        <div className="flex min-h-0 grow flex-col">
          {children ?? (
            <div className="relative flex min-h-0 grow items-center justify-center max-w-(--content-max-width) mx-auto w-full border-x border-border text-muted-foreground py-12">
              <GridDot position="tl" />
              <GridDot position="tr" />
              Page not found
            </div>
          )}
        </div>
        <Footer />
      </body>
    </html>
  )
}


function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
    </svg>
  )
}

function TabBar({
  projectId,
  pathname,
  firstEnvSlug,
}: {
  projectId: string
  pathname: string
  firstEnvSlug: string | null
}) {
  const base = `/dash/projects/${projectId}`
  const envMatch = pathname.match(new RegExp(`^${base}/envs/([^/]+)`))
  const envSlug = envMatch?.[1] ?? firstEnvSlug
  const secretsHref = envSlug
    ? router.href('/dash/projects/:projectId/envs/:envSlug', { projectId, envSlug })
    : router.href('/dash/projects/:projectId', { projectId })
  const eventLogHref = envSlug
    ? router.href('/dash/projects/:projectId/envs/:envSlug/event-log', { projectId, envSlug })
    : router.href('/dash/projects/:projectId/event-log', { projectId })
  const tabs = [
    { label: 'Secrets', href: secretsHref, active: pathname === base || (pathname.startsWith(`${base}/envs`) && !pathname.endsWith('/event-log')) },
    { label: 'Environments', href: router.href('/dash/projects/:projectId/environments', { projectId }), active: pathname === `${base}/environments` },
    { label: 'Tokens', href: router.href('/dash/projects/:projectId/tokens', { projectId }), active: pathname === `${base}/tokens` },
    { label: 'Access', href: router.href('/dash/projects/:projectId/access', { projectId }), active: pathname === `${base}/access` },
    {
      label: 'Event Log',
      href: eventLogHref,
      active: pathname === `${base}/event-log` || pathname.endsWith('/event-log'),
    },
    { label: 'Settings', href: router.href('/dash/projects/:projectId/settings', { projectId }), active: pathname === `${base}/settings` },
  ] as const

  return (
    <div className="relative max-w-(--content-max-width) mx-auto w-full border-x border-border">
      <GridDot position="tl" />
      <GridDot position="tr" />
      <GridDot position="bl" />
      <GridDot position="br" />
      <div className="flex h-10 items-stretch gap-4 sm:gap-6 px-4 sm:px-6 overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "relative flex items-center shrink-0 whitespace-nowrap text-sm no-underline transition-colors duration-150",
              tab.active
                ? "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.active && (
              <div className="absolute bottom-0 left-0 w-full h-[2.5px] bg-primary rounded-sm" />
            )}
          </Link>
        ))}
      </div>
    </div>
  )
}

/** Decorative dot placed at border intersections. Must be inside a relative container.
    Outer circle masks the border crossing with the page bg, inner dot marks the joint. */
const gridDotPosition = {
  tl: 'top-0 left-0 -translate-x-1/2 -translate-y-1/2',
  tr: 'top-0 right-0 translate-x-1/2 -translate-y-1/2',
  bl: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2',
  br: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2',
} as const

function GridDot({ position }: { position: keyof typeof gridDotPosition }) {
  return (
    <div aria-hidden className={cn(
      'absolute z-20 size-5 rounded-full bg-background pointer-events-none',
      'after:content-[""] after:block after:size-[2px] after:rounded-full after:bg-foreground/40 after:m-auto',
      'flex items-center justify-center',
      gridDotPosition[position],
    )} />
  )
}

function ContentFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("min-h-0 grow max-w-(--content-max-width) mx-auto w-full border-x border-border", className)}>
      {children}
    </div>
  )
}

function Navbar({ mobileMenuSlot }: { mobileMenuSlot?: React.ReactNode }) {
  return (
    <nav className="sticky top-0 z-50 w-full shrink-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="relative max-w-(--content-max-width) mx-auto border-x border-border">
        <GridDot position="bl" />
        <GridDot position="br" />
        <div className="flex h-14 items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2">
            {mobileMenuSlot}
            {/* Plain <a>: the docs home route is registered as '' (holocron
                index.mdx), so '/' is not in the typed Link path union. A full
                navigation to the docs shell is fine here. */}
            <a href="/" className="text-primary hover:opacity-80 transition-opacity">
              <SigilloLogo className="h-[36px] w-auto shrink-0" />
            </a>
          </div>
          <div className="hidden md:flex items-center gap-3">
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

async function Footer() {
  const { FooterColo, ThemeSelect } = await import('sigillo-app/src/components/sidebar')
  return (
    <footer className="flex shrink-0 flex-col">
      <div className="border-t border-border" />
      <div className="relative max-w-(--content-max-width) grow mx-auto w-full border-x border-border">
        <GridDot position="tl" />
        <GridDot position="tr" />
        <div className="flex flex-wrap items-center justify-end gap-4 px-6 py-5">
          <ThemeSelect />
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

// Browser telemetry: project id is passed at request time from the worker
// env instead of being inlined at build time, because the same vite build
// output is packaged into the self-host bundle. Self-hosted instances have
// no STRADA_PROJECT_ID binding, so this renders nothing for them.
async function StradaShellBrowser() {
  if (!env.STRADA_PROJECT_ID) return null
  const { StradaBrowser } = await import('sigillo-app/src/components/strada-browser')
  return <StradaBrowser projectId={env.STRADA_PROJECT_ID} environment={env.STRADA_ENVIRONMENT} />
}

export type App = typeof app

export default {
  fetch: (request: Request) => {
    // Cache API keys must live on this Worker's own origin, and that origin is
    // only knowable from a real request (preview, production, and every
    // self-hosted instance run on different domains). No-op after the first call.
    rememberCacheOrigin(request.url)
    // Safe to call on every request — no-op after the first call.
    // Gated so self-hosted instances (no STRADA_PROJECT_ID binding) send nothing.
    if (env.STRADA_PROJECT_ID) {
      initStrada({
        projectId: env.STRADA_PROJECT_ID,
        token: env.STRADA_TOKEN,
        service: 'sigillo-app',
        environment: env.STRADA_ENVIRONMENT,
      })
    }
    return app.handle(request)
  },
} satisfies ExportedHandler<Env>

declare module 'spiceflow/react' {
  interface SpiceflowRegister { app: typeof app }
}
