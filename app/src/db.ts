// Worker-level database client, auth, encryption, and authorization guards.
//
// getDb() creates a drizzle-orm/d1 client bound to env.DB. The schema uses
// epochMs custom columns that accept both Date and number inputs, so
// BetterAuth's Date params are converted to epoch ms before reaching D1.
// getAuth(request) creates a BetterAuth instance backed by the same drizzle
// client for the current request host. encrypt()/decrypt() use ENCRYPTION_KEY
// when set, otherwise derive a stable AES-256 key from BETTER_AUTH_SECRET.

import { env } from 'cloudflare:workers'
import * as orm from 'drizzle-orm'
import { getDb, schema } from 'db'
import { betterAuth } from 'better-auth/minimal'
import { genericOAuth, deviceAuthorization, bearer } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import { redirect } from 'spiceflow'
import { memoize } from './lib/memoize.ts'
import { COMMON_EMAIL_DOMAINS, getEmailDomain } from './lib/utils.ts'
export { COMMON_EMAIL_DOMAINS, getEmailDomain }

// ── Drizzle client via D1 ───────────────────────────────────────────
export { getDb }

// ── OAuth client registration ───────────────────────────────────────
// Registers this instance with the provider via RFC 7591 dynamic client
// registration on first request for a hostname, then caches the client_id by
// hostname.

export function getRequestOrigin(request: Request): string {
  const publicOrigin = getPublicOriginOverride(request)
  if (publicOrigin) {
    return publicOrigin
  }

  return new URL(request.url).origin
}

function getRequestHost(request: Request): string {
  const publicOrigin = getPublicOriginOverride(request)
  if (publicOrigin) {
    return new URL(publicOrigin).host.toLowerCase()
  }

  return new URL(request.url).host.toLowerCase()
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

function originFromHost(host: string, protocol = 'https'): string {
  const hostname = host.split(':')[0] ?? host
  const safeProtocol = protocol === 'http' || protocol === 'https' ? protocol : 'https'
  const scheme = isLocalHost(hostname) ? 'http' : safeProtocol
  return `${scheme}://${host}`
}

// IMPORTANT: This function MUST only run when request.url is localhost.
// The isLocalHost guard below is critical for security. In production,
// Cloudflare Workers set request.url to the real hostname (e.g. sigillo.dev),
// so this function returns null immediately and never reads forwarded headers.
//
// If this guard were removed, an attacker could inject X-Forwarded-Host: evil.com
// to make BetterAuth set baseURL and trustedOrigins to evil.com, redirecting
// the OAuth callback there and stealing the user's auth code/credentials.
//
// This override only exists for local dev behind a tunnel (e.g. traforo),
// where request.url is localhost but the real public URL is the tunnel domain.
function getPublicOriginOverride(request: Request): string | null {
  const requestUrl = new URL(request.url)
  if (!isLocalHost(requestUrl.hostname)) {
    return null
  }

  const forwardedHost = request.headers.get('x-forwarded-host')
  if (forwardedHost) {
    const host = forwardedHost.split(',')[0]!.trim().toLowerCase()
    const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
    return originFromHost(host, protocol)
  }

  const origin = request.headers.get('origin')
  if (origin) {
    const originUrl = new URL(origin)
    if (!isLocalHost(originUrl.hostname)) {
      return originUrl.origin
    }
  }

  const referer = request.headers.get('referer')
  if (referer) {
    const refererUrl = new URL(referer)
    if (!isLocalHost(refererUrl.hostname)) {
      return refererUrl.origin
    }
  }

  const traforoUrl = process.env.TRAFORO_URL
  if (!traforoUrl) {
    return null
  }

  return traforoUrl
}

const listOAuthHosts = memoize({
  namespace: 'oauth-hosts',
  fn: async (): Promise<string[] | null> => {
    const db = getDb()
    const rows = await db.select({ host: schema.oauthDomain.host })
      .from(schema.oauthDomain)
      .orderBy(schema.oauthDomain.createdAt)
    if (rows.length === 0) return null
    return rows.map((row) => row.host)
  },
})

// Better Auth trusts the current request host plus previously registered hosts.
// This is safe in the current Cloudflare Workers setup because the host is tied
// to Cloudflare routing, not an arbitrary forged incoming Host header:
// - Custom Domains require an exact hostname match to invoke the worker:
//   https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
// - Workers/resolveOverride keep Host aligned with the URL for security reasons:
//   https://developers.cloudflare.com/workers/runtime-apis/request/
// - Cloudflare explicitly says forged Host headers are blocked to prevent
//   bypassing other customers' security settings:
//   https://news.ycombinator.com/item?id=25058579
// If ingress ever moves outside that model (extra proxies, wildcard SaaS
// routing, etc.), revisit this and add an explicit app-level allowlist instead
// of trusting DB entries.
async function readOAuthClientId(host: string): Promise<string | null> {
  const db = getDb()
  const [row] = await db.select({ oauthClientId: schema.oauthDomain.oauthClientId })
    .from(schema.oauthDomain)
    .where(orm.eq(schema.oauthDomain.host, host))
    .limit(1)
  return row?.oauthClientId ?? null
}

const lookupOAuthClientId = memoize({
  namespace: 'oauth-client',
  fn: readOAuthClientId,
})

export async function ensureOAuthClient(request: Request): Promise<string> {
  const pathname = new URL(request.url).pathname
  const host = getRequestHost(request)
  const hostname = host.split(':')[0] ?? host
  const isLocal = isLocalHost(hostname)
  const isOAuthCallback = pathname.startsWith('/api/auth/callback/')
  const cachedClientId = isLocal && isOAuthCallback
    ? await readOAuthClientId(host)
    : await lookupOAuthClientId(host)

  if (cachedClientId && (!isLocal || isOAuthCallback)) {
    return cachedClientId
  }

  // Allow *.workers.dev hosts so self-hosters can use the app immediately
  // after deploying via `npx sigillo self-host`, before adding a custom
  // domain. The Cache API (memoize) won't work on *.workers.dev but auth and
  // the rest of the app function correctly.

  const origin = getRequestOrigin(request)
  // The redirect_uri MUST exactly match what genericOAuth sends to the provider's
  // /authorize endpoint (the provider does a strict string compare; a mismatch
  // yields `invalid_redirect`). Since better-auth 1.7, genericOAuth is registered
  // as a social provider and uses the CORE callback route `/api/auth/callback/:id`,
  // NOT the old `/api/auth/oauth2/callback/:id`. Keep this path in sync with the
  // `isOAuthCallback` check above if better-auth ever changes the callback route.
  const callbackUrl = new URL('/api/auth/callback/sigillo', origin).toString()
  // Localhost callback URLs are cheap disposable registrations. Refresh them on
  // sign-in requests so stale provider-side client ids never break local login,
  // but keep the cached id during the OAuth callback so the code exchange uses
  // the same client that started the flow.
  const res = await fetch(`${env.PROVIDER_URL}/api/auth/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `Sigillo Self-Hosted (${origin})`,
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid email profile',
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`OAuth client registration failed: ${res.status} ${body}`)
  }
  const { client_id }: { client_id: string } = await res.json()

  const db = getDb()
  await db.insert(schema.oauthDomain)
    .values({ host, oauthClientId: client_id })
    .onConflictDoUpdate({
      target: schema.oauthDomain.host,
      set: { oauthClientId: client_id, updatedAt: Date.now() },
    })

  return client_id
}

// ── BetterAuth ──────────────────────────────────────────────────────

export async function getAuth(request: Request) {
  const db = getDb()
  const host = getRequestHost(request)
  const clientId = await ensureOAuthClient(request)
  const trustedOrigins = ((await listOAuthHosts()) ?? []).map((host) => originFromHost(host))
  trustedOrigins.push(originFromHost(host))
  return betterAuth({
    baseURL: getRequestOrigin(request),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    trustedOrigins: Array.from(new Set(trustedOrigins)),
    // Enable email/password signup in tests so tests can create users via
    // auth.api.signUpEmail() and get bearer tokens without needing the
    // OAuth provider. No-op in production since the UI only shows genericOAuth.
    // VITEST var is set in wrangler.test.jsonc, propagated to process.env by nodejs_compat.
    emailAndPassword: { enabled: !!process.env.VITEST },
    // No cookie cache: a session ended on the Sessions page must stop working
    // on its next request, not up to 5 minutes later. It costs one D1 read.
    // Sessions record the client IP Cloudflare puts in cf-connecting-ip.
    advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'sigillo',
            clientId,
            clientSecret: '',
            // Auto-discover all endpoints from the provider's OIDC metadata
            discoveryUrl: `${env.PROVIDER_URL}/api/auth/.well-known/openid-configuration`,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
            // Always let the user pick which Google account to use. Without
            // this the provider silently reuses its own session (and the
            // consent step is auto-accepted for first-party clients), so
            // pressing "Sign in with Google" never showed a choice — you got
            // whichever account the provider last saw. The provider maps
            // prompt=select_account onto its /select-account route, which
            // restarts the Google sign-in and then resumes the authorize flow
            // via /oauth2/continue.
            prompt: 'select_account',
          },
        ],
      }),
      deviceAuthorization({ verificationUri: '/device', schema: {} }),
      bearer(),

    ],
  })
}

// ── Data center location ────────────────────────────────────────────

export function getDataCenter(request: Request & { cf?: { colo?: string } }): string {
  return request.cf?.colo ?? 'unknown'
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string; emailVerified: boolean } }

// Spiceflow passes the SAME request instance to every matched loader/layout in
// a single navigation (verified against the framework source). Several loaders
// call getSession concurrently for one navigation, so without deduping each
// would rebuild a BetterAuth instance and re-validate the session — and on a
// cold cookie cache, each would hit D1 for the same session. Memoizing the
// resolution per request collapses those into one. The WeakMap lets entries be
// GC'd once the request is gone, so it never leaks across requests.
const sessionByRequest = new WeakMap<Request, Promise<Session | null>>()

export function getSession(request: Request): Promise<Session | null> {
  const cached = sessionByRequest.get(request)
  if (cached) return cached
  const promise = resolveSession(request)
  sessionByRequest.set(request, promise)
  return promise
}

async function resolveSession(request: Request): Promise<Session | null> {
  const hasCookie = request.headers.has('cookie')
  const hasAuthorization = request.headers.has('authorization')
  if (!hasCookie && !hasAuthorization) {
    return null
  }

  const auth = await getAuth(request)
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return { userId: session.user.id, user: { id: session.user.id, name: session.user.name, email: session.user.email, emailVerified: session.user.emailVerified } }
}

// ── Your sessions ───────────────────────────────────────────────────
// Through better-auth, which only ever touches the signed-in user's own
// sessions. Its session list carries each session's token, so tokens stay
// on the server: the page gets ids, and ending one looks its token up again.

// null when this login is too old to list sessions: from better-auth 1.7.6
// on, that needs one from the last day (freshAge), and the page then asks to
// sign in again
export async function listUserSessions(request: Request) {
  const auth = await getAuth(request)
  const current = await auth.api.getSession({ headers: request.headers })
  let sessions
  try {
    sessions = await auth.api.listSessions({ headers: request.headers })
  } catch (error) {
    if (isNotFresh(error)) return null
    throw error
  }
  return sessions.map((session) => ({
    id: session.id,
    createdAt: new Date(session.createdAt).getTime(),
    // better-auth stores '' when a request has no IP or user agent
    ipAddress: session.ipAddress || null,
    userAgent: session.userAgent || null,
    isCurrent: session.id === current?.session.id,
  }))
}

// better-auth's APIError when a login is too old for the endpoint
function isNotFresh(error: unknown) {
  return (error as { body?: { code?: string } } | null)?.body?.code === 'SESSION_NOT_FRESH'
}

export async function endUserSession(request: Request, sessionId: string) {
  const auth = await getAuth(request)
  const sessions = await auth.api.listSessions({ headers: request.headers })
  const token = sessions.find((session) => session.id === sessionId)?.token
  if (token) await auth.api.revokeSession({ body: { token }, headers: request.headers })
}

export async function endOtherUserSessions(request: Request) {
  const auth = await getAuth(request)
  await auth.api.revokeOtherSessions({ headers: request.headers })
}

export async function requireApiSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  return session
}

export async function requirePageSession(request: Request): Promise<Session> {
  const session = await getSession(request)
  if (!session) throw redirect('/login')
  return session
}

// ── Domain auto-join ────────────────────────────────────────────────
// Automatically adds a user as a member to any org whose autoJoinDomain
// matches the user's verified email domain. Runs on every /dash/* page
// load. Uses onConflictDoNothing so it's idempotent; no need to pre-check
// existing memberships (the unique index on org_id+user_id handles it).

export async function autoJoinOrgsByDomain(session: Session): Promise<void> {
  if (!session.user.emailVerified) return
  const domain = getEmailDomain(session.user.email)
  if (!domain || COMMON_EMAIL_DOMAINS.has(domain)) return

  const db = getDb()

  // Find orgs with matching auto-join domain
  const matchingOrgs = await db.query.org.findMany({
    where: { autoJoinDomain: domain },
    columns: { id: true },
  })
  if (matchingOrgs.length === 0) return

  // Insert memberships with onConflictDoNothing — the unique index on
  // (org_id, user_id) prevents duplicates, so we skip already-joined orgs
  // without needing a separate membership read.
  const [firstQuery, ...restQueries] = matchingOrgs.map((o) =>
    db.insert(schema.orgMember)
      .values({ orgId: o.id, userId: session.userId, role: 'member' })
      .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] }),
  )
  await db.batch([firstQuery!, ...restQueries])
}

// ── Granular project access ─────────────────────────────────────────
// orgMember.projectAccess 'all' → every project; 'selected' → only projects
// in memberAccess (none if zero rows). Admins always bypass restrictions.

// Membership + granular access in ONE round-trip. db.query with `with` emits
// a single SQL statement (accessRules joined via the orgMember relation), so
// this replaces the previous two sequential queries. Because it looks up the
// orgMember row, it doubles as the org-membership check: callers that are
// happy with a plain forbidden outcome for non-members can skip a separate
// requireOrgMember round-trip entirely.
export async function getMemberAccess({ userId, orgId }: {
  userId: string
  orgId: string
}): Promise<{
  role: (typeof schema.orgMember.$inferSelect)['role']
  /** null = unrestricted (admin, or projectAccess 'all'); string[] = only these projects */
  accessibleProjectIds: string[] | null
} | null> {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { userId, orgId },
    with: { accessRules: true },
  })
  if (!member) return null
  if (member.role === 'admin' || member.projectAccess === 'all') {
    return { role: member.role, accessibleProjectIds: null }
  }
  return { role: member.role, accessibleProjectIds: member.accessRules.map((r) => r.projectId) }
}

// Check if a specific member has access to a specific project.
// Also verifies org membership (false for non-members) — no separate
// requireOrgMember call needed when a 403 is the desired failure mode.
export async function getMemberProjectAccess({ userId, orgId, projectId }: {
  userId: string
  orgId: string
  projectId: string
}): Promise<boolean> {
  const access = await getMemberAccess({ userId, orgId })
  if (!access) return false
  return access.accessibleProjectIds === null || access.accessibleProjectIds.includes(projectId)
}

// Get list of project IDs a member can access, or null if unrestricted.
// null = all projects (admin, or projectAccess 'all').
// string[] = only these project IDs ([] for non-members).
export async function getAccessibleProjectIds(
  userId: string,
  orgId: string,
): Promise<string[] | null> {
  const access = await getMemberAccess({ userId, orgId })
  if (!access) return []
  return access.accessibleProjectIds
}

// ── Org authorization ───────────────────────────────────────────────

// Membership and environment lookups are deliberately NOT memoized: they
// carry authorization data (role, accessRole), and a Cache API entry cannot
// be invalidated everywhere (it is per data center), so a removed member or
// a newly admin-only environment kept working for up to 15 minutes.
async function lookupOrgMember(userId: string, orgId: string): Promise<{ role: string } | null> {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({ where: { userId, orgId } })
  if (!member) return null
  return { role: member.role }
}

// Distinct class instead of `new Error('FORBIDDEN')` so the API/page wrappers
// below can tell an authorization denial apart from an infrastructure failure.
// A bare `catch {}` there used to turn D1 outages into a bogus 403/redirect,
// hiding real errors from Strada and from the user.
export class ForbiddenError extends Error {
  constructor(message = 'FORBIDDEN') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export async function requireOrgMember(userId: string, orgId: string) {
  const member = await lookupOrgMember(userId, orgId)
  if (!member) throw new ForbiddenError()
  return member
}

export async function requireApiOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error
    throw new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
}

export async function requirePageOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error
    throw redirect('/')
  }
}

// ── Org ownership chain lookups ─────────────────────────────────────

export const getOrgIdForProject = memoize({
  namespace: 'project-org',
  fn: async (projectId: string): Promise<string | null> => {
    const db = getDb()
    const row = await db.query.project.findFirst({ where: { id: projectId }, columns: { orgId: true } })
    return row?.orgId ?? null
  },
})

// Resolve an environment identifier (ULID or slug) to { id, projectId, slug, orgId }.
// Tries ID first, falls back to slug within the project scope.
type ResolvedEnvironment = {
  id: string
  projectId: string
  name: string
  slug: string
  accessRole: string
  createdAt: number
  updatedAt: number
  orgId: string | null
}

// Not memoized: carries accessRole (see lookupOrgMember).
export async function resolveEnvironment(identifier: string, projectId?: string | null): Promise<ResolvedEnvironment | null> {
  const db = getDb()
  const byId = await db.query.environment.findFirst({
    where: { id: identifier },
    with: { project: { columns: { orgId: true } } },
  })
  if (byId) return { ...byId, orgId: byId.project?.orgId ?? null }
  if (projectId) {
    const bySlug = await db.query.environment.findFirst({
      where: { projectId, slug: identifier },
      with: { project: { columns: { orgId: true } } },
    })
    if (bySlug) return { ...bySlug, orgId: bySlug.project?.orgId ?? null }
  }
  return null
}

// ── Environment authorization ───────────────────────────────────────
// One rule for every secret read/write path (REST API, pages, actions):
// org member + project access + admin role for admin-only envs.

type MemberAccess = NonNullable<Awaited<ReturnType<typeof getMemberAccess>>>

export function getEnvironmentAccessError(
  access: MemberAccess | null,
  env: { projectId: string; accessRole: string },
): string | null {
  if (!access) return 'forbidden'
  if (access.accessibleProjectIds !== null && !access.accessibleProjectIds.includes(env.projectId)) {
    return 'you do not have access to this project'
  }
  if (env.accessRole === 'admin' && access.role !== 'admin') return 'admin access required for this environment'
  return null
}

export async function getProjectMemberAccess(userId: string, projectId: string) {
  const orgId = await getOrgIdForProject(projectId)
  return orgId ? getMemberAccess({ userId, orgId }) : null
}

// Returns null when the environment does not exist; throws ForbiddenError
// when the user may not access it.
export async function getUserEnvironmentAccess({ userId, environmentRef, projectId }: {
  userId: string
  environmentRef: string
  projectId?: string | null
}) {
  const env = await resolveEnvironment(environmentRef, projectId)
  if (!env?.orgId) return null
  const access = await getMemberAccess({ userId, orgId: env.orgId })
  const error = getEnvironmentAccessError(access, env)
  if (error || !access) throw new ForbiddenError(error ?? 'forbidden')
  return { id: env.id, projectId: env.projectId, orgId: env.orgId, role: access.role }
}

export async function getOrgIdForEnvironment(environmentId: string, projectId?: string | null) {
  const env = await resolveEnvironment(environmentId, projectId)
  return env?.orgId ?? null
}

export async function getProjectIdForEnvironment(environmentId: string, projectId?: string | null) {
  const env = await resolveEnvironment(environmentId, projectId)
  return env?.projectId ?? null
}

// ── Derive current secrets from event log ───────────────────────────
// Replays the append-only secretEvent log for an environment and returns
// the current state: last "set" event per name wins, "delete" removes it.

export type DerivedSecret = {
  id: string
  name: string
  valueEncrypted: string
  iv: string
  createdAt: number
  updatedAt: number
  userId: string | null
}

// Minimal shape of a secret event row needed to replay current state.
type SecretEventRow = {
  id: string
  name: string
  operation: string
  valueEncrypted: string | null
  iv: string | null
  userId: string | null
  createdAt: number
}

// Replay an append-only event log (ordered by createdAt asc) into the current
// set of secrets. Last "set" per name wins; "delete" removes it. Rows missing
// a value/iv are dropped. Pure — no DB access, so it can run on rows fetched
// from any query or batch.
function replaySecretEvents(events: SecretEventRow[]): DerivedSecret[] {
  const state = new Map<string, {
    id: string
    name: string
    valueEncrypted: string | null
    iv: string | null
    userId: string | null
    createdAt: number
    firstCreatedAt: number
  }>()

  for (const evt of events) {
    const existing = state.get(evt.name)
    if (evt.operation === 'delete') {
      state.delete(evt.name)
    } else {
      state.set(evt.name, {
        id: evt.id,
        name: evt.name,
        valueEncrypted: evt.valueEncrypted,
        iv: evt.iv,
        userId: evt.userId,
        createdAt: evt.createdAt,
        firstCreatedAt: existing?.firstCreatedAt ?? evt.createdAt,
      })
    }
  }

  return Array.from(state.values())
    .filter((s) => s.valueEncrypted && s.iv)
    .map((s) => ({
      id: s.id,
      name: s.name,
      valueEncrypted: s.valueEncrypted!,
      iv: s.iv!,
      createdAt: s.firstCreatedAt,
      updatedAt: s.createdAt,
      userId: s.userId,
    }))
}

export async function deriveSecrets(environmentId: string): Promise<DerivedSecret[]> {
  const db = getDb()
  const events = await db.query.secretEvent.findMany({
    where: { environmentId },
    orderBy: { createdAt: 'asc' },
  })
  return replaySecretEvents(events)
}

// ── Derive secrets for one env + all names across envs in ONE batch ─
// The project secrets page needs two things: the decryptable secrets for the
// selected environment, and the union of secret names across every environment
// (to render the "missing in this env" hints). Previously this was two separate
// round-trips (deriveSecrets + deriveAllSecretNames). This folds every
// secret_event read into a single db.batch so the whole page costs one D1
// round-trip for secret data instead of N+1.
export async function deriveEnvironmentSecretsAndNames(
  { environmentIds, selectedEnvId }: { environmentIds: string[]; selectedEnvId: string | null },
): Promise<{ secrets: DerivedSecret[]; allNames: string[] }> {
  if (environmentIds.length === 0) return { secrets: [], allNames: [] }
  const db = getDb()

  const [firstEnvId, ...restEnvIds] = environmentIds
  const results = await db.batch([
    db.query.secretEvent.findMany({
      where: { environmentId: firstEnvId },
      orderBy: { createdAt: 'asc' },
    }),
    ...restEnvIds.map((envId) =>
      db.query.secretEvent.findMany({
        where: { environmentId: envId },
        orderBy: { createdAt: 'asc' },
      }),
    ),
  ])

  const allNames = new Set<string>()
  let selectedEvents: SecretEventRow[] = []
  for (let i = 0; i < environmentIds.length; i++) {
    const events = results[i]!
    if (environmentIds[i] === selectedEnvId) selectedEvents = events
    for (const secret of replaySecretEvents(events)) allNames.add(secret.name)
  }

  return {
    secrets: selectedEnvId ? replaySecretEvents(selectedEvents) : [],
    allNames: [...allNames].sort(),
  }
}

// ── Secrets API auth (session OR bearer token) ─────────────────────
// Unified auth for secrets API routes. Accepts either:
// 1. Session cookie → verifies org membership, returns { userId }
// 2. Authorization: Bearer sig_... → verifies token scope, returns { apiTokenId }
//
// Exactly one of userId/apiTokenId is set in the return value. This maps
// directly to secretEvent columns — the event log shows either the user
// name or the API token name depending on which performed the action.

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })
}

function forbiddenResponse(msg = 'forbidden'): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 403, headers: { 'content-type': 'application/json' },
  })
}

export type SecretsAuth = (
  | { userId: string; apiTokenId: null }
  | { userId: null; apiTokenId: string }
)

// Environments of a project the caller may read, with the same rules as
// requireSecretsApiAuth. Used where one request touches several envs (e.g.
// the allNames list), so names from admin-only or out-of-scope envs never leak.
export async function getReadableEnvironmentIds(auth: SecretsAuth, projectId: string): Promise<string[]> {
  const db = getDb()
  const [environments, orgId] = await Promise.all([
    db.query.environment.findMany({ where: { projectId }, columns: { id: true, projectId: true, accessRole: true } }),
    getOrgIdForProject(projectId),
  ])
  if (!orgId) return []
  if (auth.userId) {
    const access = await getMemberAccess({ userId: auth.userId, orgId })
    return environments.filter((env) => !getEnvironmentAccessError(access, env)).map((env) => env.id)
  }
  if (!auth.apiTokenId) return []
  const token = await db.query.apiToken.findFirst({
    where: { id: auth.apiTokenId },
    columns: { projectId: true, createdBy: true },
    with: { environments: { columns: { environmentId: true } } },
  })
  if (!token || token.projectId !== projectId) return []
  const allowlist = token.environments.length > 0 ? new Set(token.environments.map((row) => row.environmentId)) : null
  const creator = await getMemberAccess({ userId: token.createdBy, orgId })
  return environments
    .filter((env) => !allowlist || allowlist.has(env.id))
    .filter((env) => env.accessRole !== 'admin' || creator?.role === 'admin')
    .map((env) => env.id)
}

// The environmentRef can be either a ULID or a slug. For token auth the
// token's project scope is used to resolve slugs. For session auth we
// need the caller to pass projectId when using a slug.
// Returns { auth, environmentId } where environmentId is the resolved ULID.
export async function requireSecretsApiAuth(
  {
    request,
    environmentRef,
    projectId,
  }: {
    request: Request
    environmentRef: string
    projectId?: string | null
  },
): Promise<SecretsAuth & { environmentId: string }> {
  const apiToken = await getRequestApiToken(request)
  if (apiToken) {
    const env = await resolveEnvironment(environmentRef, apiToken.projectId)
    if (!env || env.projectId !== apiToken.projectId) throw forbiddenResponse('token does not have access to this environment')
    if (apiToken.environmentIds && !apiToken.environmentIds.includes(env.id)) {
      throw forbiddenResponse('token is scoped to a different environment')
    }
    // Admin-only envs: the token acts for its creator, who must still be an
    // org admin. Covers tokens made by members, and admins later demoted.
    if (env.accessRole === 'admin') {
      const creator = env.orgId ? await getMemberAccess({ userId: apiToken.createdBy, orgId: env.orgId }) : null
      if (creator?.role !== 'admin') throw forbiddenResponse('admin access required for this environment')
    }
    return { userId: null, apiTokenId: apiToken.tokenId, environmentId: env.id }
  }

  // Session auth path — works with both cookies and BetterAuth bearer tokens
  const session = await getSession(request)
  if (!session) throw unauthorizedResponse()

  try {
    const env = await getUserEnvironmentAccess({ userId: session.userId, environmentRef, projectId })
    if (!env) throw new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    return { userId: session.userId, apiTokenId: null, environmentId: env.id }
  } catch (error) {
    if (error instanceof ForbiddenError) throw forbiddenResponse(error.message)
    throw error
  }
}

// ── API token helpers ───────────────────────────────────────────────
// Tokens use SHA-256 hashing — the full key is never stored, only shown
// once at creation. generateApiToken() creates the raw key + hash + prefix.
// verifyApiToken() looks up a key by its hash for API authentication.

export async function hashTokenKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateApiToken(): Promise<{ key: string; hashedKey: string; prefix: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const raw = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const key = `sig_${raw}`
  const hashedKey = await hashTokenKey(key)
  const prefix = raw.slice(0, 12)
  return { key, hashedKey, prefix }
}

export async function verifyApiToken(key: string): Promise<{
  tokenId: string
  projectId: string
  createdBy: string
  environmentIds: string[] | null
} | null> {
  const hashedKey = await hashTokenKey(key)
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { hashedKey },
    columns: { id: true, projectId: true, createdBy: true },
    with: { environments: { columns: { environmentId: true } } },
  })
  if (!token) return null
  return {
    tokenId: token.id,
    projectId: token.projectId,
    createdBy: token.createdBy,
    environmentIds: token.environments.length === 0
      ? null
      : token.environments.map((row) => row.environmentId),
  }
}

// Reads a sig_ bearer token from the request. Returns null when the request
// is not token auth (cookie session or BetterAuth bearer). Invalid sig_
// tokens throw 401 so they never fall through to session auth.
export async function getRequestApiToken(request: Request): Promise<{
  tokenId: string
  projectId: string
  createdBy: string
  environmentIds: string[] | null
} | null> {
  const authHeader = request.headers.get('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!bearer?.startsWith('sig_')) return null
  const token = await verifyApiToken(bearer)
  if (!token) throw unauthorizedResponse()
  return token
}

// ── Encryption (AES-256-GCM) ────────────────────────────────────────

async function getEncryptionKey(): Promise<CryptoKey> {
  const configuredKey = process.env.ENCRYPTION_KEY?.trim()
  if (configuredKey) {
    const raw = Uint8Array.from(atob(configuredKey), (c) => c.charCodeAt(0))
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }

  // AES-256 needs exactly 32 bytes. Hashing the Better Auth secret gives a
  // stable 32-byte fallback key. Plain base64-encoding the secret text would
  // produce variable-length bytes and break encryption.
  const derived = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.BETTER_AUTH_SECRET))
  return crypto.subtle.importKey('raw', derived, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encrypt(plaintext: string): Promise<{ encrypted: string; iv: string }> {
  const key = await getEncryptionKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)
  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
    iv: btoa(String.fromCharCode(...iv)),
  }
}

export async function decrypt(encrypted: string, iv: string): Promise<string> {
  const key = await getEncryptionKey()
  const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0))
  const ciphertext = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBytes }, key, ciphertext)
  return new TextDecoder().decode(plaintext)
}
