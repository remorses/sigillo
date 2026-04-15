// Worker-level database client, auth, encryption, and authorization guards.
// The DO is a thin SQL proxy — all logic runs here in the worker.
//
// getDb() creates a drizzle-orm/sqlite-proxy client that routes SQL to the
// DO's executeSql() RPC. getAuth() creates a BetterAuth instance backed by
// the same drizzle client. encrypt()/decrypt() use env.ENCRYPTION_KEY.

import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as orm from 'drizzle-orm'
import * as schema from 'db/src/app-schema.ts'
import { betterAuth } from 'better-auth'
import { genericOAuth, deviceAuthorization } from 'better-auth/plugins'
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
  return drizzle(async (sql, params, method) => {
    return stub.executeSql(sql, params, method)
  }, { schema, relations: schema.relations })
}

// ── BetterAuth ──────────────────────────────────────────────────────

export function getAuth() {
  const db = getDb()
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: 'sqlite' }),
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: 'sigillo',
            clientId: env.OAUTH_CLIENT_ID,
            clientSecret: '',
            // Auto-discover all endpoints from the provider's OIDC metadata
            discoveryUrl: `${env.PROVIDER_URL}/api/auth/.well-known/openid-configuration`,
            scopes: ['openid', 'email', 'profile'],
            pkce: true,
          },
        ],
      }),
      deviceAuthorization({ verificationUri: '/device' }),
    ],
  })
}

// ── Session helpers ─────────────────────────────────────────────────

type Session = { userId: string; user: { id: string; name: string; email: string } }

export async function getSession(headers: Headers): Promise<Session | null> {
  const auth = getAuth()
  const session = await auth.api.getSession({ headers })
  if (!session) return null
  return { userId: session.user.id, user: { id: session.user.id, name: session.user.name, email: session.user.email } }
}

export async function requireApiSession(request: Request): Promise<Session> {
  const session = await getSession(request.headers)
  if (!session) throw new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
  return session
}

export async function requirePageSession(request: Request): Promise<Session> {
  const session = await getSession(request.headers)
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

export async function getOrgIdForSecret(secretId: string) {
  const db = getDb()
  const row = await db.query.secret.findFirst({
    where: { id: secretId },
    with: { environment: { with: { project: { columns: { orgId: true } } } } },
  })
  return row?.environment?.project?.orgId ?? null
}

// ── Encryption (AES-256-GCM) ────────────────────────────────────────

async function getEncryptionKey(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(env.ENCRYPTION_KEY), (c) => c.charCodeAt(0))
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
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
