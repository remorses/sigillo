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
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
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

function getPublicOriginOverride(request: Request): string | null {
  const requestUrl = new URL(request.url)
  const isLocalHost = requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1'
  if (!isLocalHost) {
    return null
  }

  const forwardedHost = request.headers.get('x-forwarded-host')
  const forwardedProto = request.headers.get('x-forwarded-proto')
  if (forwardedHost && forwardedProto) {
    return `${forwardedProto}://${forwardedHost}`
  }

  const origin = request.headers.get('origin')
  if (origin) {
    const originUrl = new URL(origin)
    if (originUrl.hostname !== 'localhost' && originUrl.hostname !== '127.0.0.1') {
      return originUrl.origin
    }
  }

  const referer = request.headers.get('referer')
  if (referer) {
    const refererUrl = new URL(referer)
    if (refererUrl.hostname !== 'localhost' && refererUrl.hostname !== '127.0.0.1') {
      return refererUrl.origin
    }
  }

  const traforoUrl = process.env.TRAFORO_URL
  if (!traforoUrl) {
    return null
  }

  return traforoUrl
}

function originForHost(host: string): string {
  const protocol = host.startsWith('localhost:') || host.startsWith('127.0.0.1:')
    ? 'http'
    : 'https'
  return `${protocol}://${host}`
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
const lookupOAuthClientId = memoize({
  namespace: 'oauth-client',
  fn: async (host: string): Promise<string | null> => {
    const db = getDb()
    const [row] = await db.select({ oauthClientId: schema.oauthDomain.oauthClientId })
      .from(schema.oauthDomain)
      .where(orm.eq(schema.oauthDomain.host, host))
      .limit(1)
    return row?.oauthClientId ?? null
  },
})

export async function ensureOAuthClient(request: Request): Promise<string> {
  const pathname = new URL(request.url).pathname
  const host = getRequestHost(request)
  const cachedClientId = await lookupOAuthClientId(host)

  const isLocalHost = host.startsWith('localhost:') || host.startsWith('127.0.0.1:')
  const isOAuthCallback = pathname.startsWith('/api/auth/oauth2/callback/')
  if (cachedClientId && (!isLocalHost || isOAuthCallback)) {
    return cachedClientId
  }

  if (host.endsWith('.workers.dev')) {
    throw new Error(`Refusing OAuth registration for temporary host: ${host}`)
  }

  const origin = getRequestOrigin(request)
  const callbackUrl = new URL('/api/auth/oauth2/callback/sigillo', origin).toString()
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
  const trustedOrigins = ((await listOAuthHosts()) ?? []).map(originForHost)
  trustedOrigins.push(originForHost(host))
  return betterAuth({
    baseURL: getRequestOrigin(request),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    trustedOrigins: Array.from(new Set(trustedOrigins)),
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
      deviceAuthorization({ verificationUri: '/device' }),
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

export async function getSession(request: Request): Promise<Session | null> {
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

export async function deriveSecrets(environmentId: string): Promise<DerivedSecret[]> {
  const db = getDb()
  const events = await db.query.secretEvent.findMany({
    where: { environmentId },
    orderBy: { createdAt: 'asc' },
  })

  // Group by name, replay to get current state
  const state = new Map<string, {
    id: string
    name: string
    operation: string
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
        operation: evt.operation,
        valueEncrypted: evt.valueEncrypted,
        iv: evt.iv,
        userId: evt.userId!,
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

// ── Derive all secret names across environments ─────────────────────
// Returns the sorted union of all active secret names across the given
// environment IDs. No decryption needed — just replays event logs for names.

export async function deriveAllSecretNames(environmentIds: string[]): Promise<string[]> {
  if (environmentIds.length === 0) return []
  const db = getDb()

  // Fetch all environments' events in a single D1 batch round-trip
  const [firstEnvironmentId, ...restEnvironmentIds] = environmentIds
  const results = await db.batch([
    db.query.secretEvent.findMany({
      where: { environmentId: firstEnvironmentId },
      columns: { name: true, operation: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    ...restEnvironmentIds.map((envId) =>
      db.query.secretEvent.findMany({
        where: { environmentId: envId },
        columns: { name: true, operation: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ),
  ])

  const allNames = new Set<string>()
  for (const events of results) {
    const active = new Set<string>()
    for (const evt of events) {
      if (evt.operation === 'delete') active.delete(evt.name)
      else active.add(evt.name)
    }
    for (const name of active) allNames.add(name)
  }

  return [...allNames].sort()
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
  const raw = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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
