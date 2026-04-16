// Worker-level database client, auth, encryption, and authorization guards.
// The DO is a thin SQL proxy — all logic runs here in the worker.
//
// getDb() creates a drizzle-orm/sqlite-proxy client that routes SQL to the
// DO's executeSql() RPC. getAuth(request) creates a BetterAuth instance backed
// by the same drizzle client for the current request host. encrypt()/decrypt()
// use ENCRYPTION_KEY when set, otherwise derive a stable AES-256 key from
// BETTER_AUTH_SECRET.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/app-schema.ts'
import { betterAuth } from 'better-auth'
import { genericOAuth, deviceAuthorization, bearer } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter/relations-v2'
import { redirect } from 'spiceflow'
import type { SecretsStore } from './secrets-store.ts'

// ── DO stub ─────────────────────────────────────────────────────────

function getStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

// ── Drizzle client via sqlite-proxy ─────────────────────────────────

export function getDb() {
  const stub = getStub()
  return drizzle(
    async (sql, params, method) => {
      // Cast needed: drizzle types expect { rows: any[] } but the get method
      // must return { rows: null } when no row is found (see secrets-store.ts).
      return stub.executeSql(sql, params, method) as any
    },
    async (batch) => {
      return stub.executeSqlBatch(batch) as any
    },
    { schema, relations: schema.relations },
  )
}

// ── OAuth client registration ───────────────────────────────────────
// Registers this instance with the provider via RFC 7591 dynamic client
// registration on first request for a hostname, then caches the client_id by
// hostname.

function getRequestOrigin(request: Request): string {
  return new URL(request.url).origin
}

function getRequestHost(request: Request): string {
  return new URL(request.url).host.toLowerCase()
}

function originForHost(host: string): string {
  const protocol = host.startsWith('localhost:') || host.startsWith('127.0.0.1:')
    ? 'http'
    : 'https'
  return `${protocol}://${host}`
}

async function listOAuthHosts(): Promise<string[]> {
  const db = getDb()
  const rows = await db.query.oauthDomain.findMany({
    columns: { host: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => row.host)
}

export async function ensureOAuthClient(request: Request): Promise<string> {
  const db = getDb()
  const host = getRequestHost(request)
  const row = await db.query.oauthDomain.findFirst({ where: { host } })
  if (row) return row.oauthClientId

  if (host.endsWith('.workers.dev')) {
    throw new Error(`Refusing OAuth registration for temporary host: ${host}`)
  }

  const origin = getRequestOrigin(request)
  const callbackUrl = new URL('/api/auth/oauth2/callback/sigillo', origin).toString()
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
  const trustedOrigins = (await listOAuthHosts()).map(originForHost)
  trustedOrigins.push(originForHost(host))
  return betterAuth({
    baseURL: getRequestOrigin(request),
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    trustedOrigins: Array.from(new Set(trustedOrigins)),
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes — avoids a DO SQL round-trip on every request
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

export function getDataCenter(): Promise<string> {
  return getStub().getColo()
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string } }

export async function getSession(request: Request): Promise<Session | null> {
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

export async function requireOrgMember(userId: string, orgId: string) {
  const db = getDb()
  const member = await db.query.orgMember.findFirst({ where: { userId, orgId } })
  if (!member) throw new Error('FORBIDDEN')
  return { role: member.role }
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

export async function getOrgIdForProject(projectId: string) {
  const db = getDb()
  const row = await db.query.project.findFirst({ where: { id: projectId }, columns: { orgId: true } })
  return row?.orgId ?? null
}

export async function getOrgIdForEnvironment(environmentId: string) {
  const db = getDb()
  const row = await db.query.environment.findFirst({
    where: { id: environmentId },
    with: { project: { columns: { orgId: true } } },
  })
  return row?.project?.orgId ?? null
}

export async function getProjectIdForEnvironment(environmentId: string) {
  const db = getDb()
  const row = await db.query.environment.findFirst({
    where: { id: environmentId },
    columns: { projectId: true },
  })
  return row?.projectId ?? null
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

  // Fetch all environments' events in a single RPC round-trip
  const results = await db.batch(
    environmentIds.map((envId) =>
      db.query.secretEvent.findMany({
        where: { environmentId: envId },
        columns: { name: true, operation: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ) as [any, ...any[]],
  )

  const allNames = new Set<string>()
  for (const events of results) {
    const active = new Set<string>()
    for (const evt of events as { name: string; operation: string }[]) {
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

export async function requireSecretsApiAuth(request: Request, environmentId: string): Promise<SecretsAuth> {
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

    // Verify the requested environment belongs to the token's project
    const envProjectId = await getProjectIdForEnvironment(environmentId)
    if (envProjectId !== token.projectId) throw forbiddenResponse('token does not have access to this environment')

    // If token is scoped to a specific environment, enforce it
    if (token.environmentId && token.environmentId !== environmentId) {
      throw forbiddenResponse('token is scoped to a different environment')
    }

    return { userId: null, apiTokenId: token.id }
  }

  // Session auth path — works with both cookies and BetterAuth bearer tokens
  const session = await getSession(request)
  if (!session) throw unauthorizedResponse()

  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })

  try {
    await requireOrgMember(session.userId, orgId)
  } catch {
    throw forbiddenResponse()
  }

  return { userId: session.userId, apiTokenId: null }
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
