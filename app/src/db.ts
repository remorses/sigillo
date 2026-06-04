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
import { betterAuth } from 'better-auth'
import { genericOAuth, deviceAuthorization, bearer } from 'better-auth/plugins'
import { drizzleAdapter } from 'better-auth-drizzle-adapter'
import { redirect } from 'spiceflow'
import { memoize } from './lib/memoize.ts'

// ── Drizzle client via D1 ───────────────────────────────────────────
export { getDb }

// ── OAuth client registration ───────────────────────────────────────
// Registers this instance with the provider via RFC 7591 dynamic client
// registration on first request for a hostname, then caches the client_id by
// hostname.

function getRequestOrigin(request: Request): string {
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
  // after deploying via the "Deploy to Cloudflare" button, before adding a
  // custom domain. The Cache API (memoize) won't work on *.workers.dev but
  // auth and the rest of the app function correctly.

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
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes — avoids a D1 round-trip on every request
      },
    },
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

type Session = { userId: string; user: { id: string; name: string; email: string } }

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
  return { userId: session.user.id, user: { id: session.user.id, name: session.user.name, email: session.user.email } }
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

// ── Org authorization ───────────────────────────────────────────────

const lookupOrgMember = memoize({
  namespace: 'org-member',
  fn: async (userId: string, orgId: string): Promise<{ role: string } | null> => {
    const db = getDb()
    const member = await db.query.orgMember.findFirst({ where: { userId, orgId } })
    if (!member) return null
    return { role: member.role }
  },
})

export async function requireOrgMember(userId: string, orgId: string) {
  const member = await lookupOrgMember(userId, orgId)
  if (!member) throw new Error('FORBIDDEN')
  return member
}

export async function requireApiOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch {
    throw new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers: { 'content-type': 'application/json' } })
  }
}

export async function requirePageOrgMember(userId: string, orgId: string) {
  try {
    return await requireOrgMember(userId, orgId)
  } catch {
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
  createdAt: number
  updatedAt: number
  orgId: string | null
}

export const resolveEnvironment = memoize({
  namespace: 'resolve-env',
  fn: async (identifier: string, projectId?: string | null): Promise<ResolvedEnvironment | null> => {
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
  },
})

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

export type SecretsAuth = { userId: string; apiTokenId: null } | { userId: null; apiTokenId: string }

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
  const authHeader = request.headers.get('authorization')
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  // API tokens use the "sig_" prefix — check those first.
  // Non-prefixed bearer tokens fall through to session auth (BetterAuth bearer plugin).
  if (bearer?.startsWith('sig_')) {
    const hashedKey = await hashTokenKey(bearer)
    const db = getDb()
    const token = await db.query.apiToken.findFirst({
      where: { hashedKey },
      columns: { id: true, projectId: true, environmentId: true },
    })
    if (!token) throw unauthorizedResponse()

    // Resolve the environment ref (ID or slug) using the token's project scope
    const env = await resolveEnvironment(environmentRef, token.projectId)
    if (!env || env.projectId !== token.projectId) throw forbiddenResponse('token does not have access to this environment')

    // If token is scoped to a specific environment, enforce it
    if (token.environmentId && token.environmentId !== env.id) {
      throw forbiddenResponse('token is scoped to a different environment')
    }

    return { userId: null, apiTokenId: token.id, environmentId: env.id }
  }

  // Session auth path — works with both cookies and BetterAuth bearer tokens
  const session = await getSession(request)
  if (!session) throw unauthorizedResponse()

  const env = await resolveEnvironment(environmentRef, projectId)
  if (!env?.orgId) throw new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })

  try {
    await requireOrgMember(session.userId, env.orgId)
  } catch {
    throw forbiddenResponse()
  }

  return { userId: session.userId, apiTokenId: null, environmentId: env.id }
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
  environmentId: string | null
} | null> {
  const hashedKey = await hashTokenKey(key)
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { hashedKey },
    columns: { id: true, projectId: true, environmentId: true },
  })
  if (!token) return null
  return { tokenId: token.id, projectId: token.projectId, environmentId: token.environmentId }
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
