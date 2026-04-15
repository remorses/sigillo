// REST API for external consumers (CLI, SDKs, agents).
// Mounted as a sub-app in app.tsx via .use(apiApp).
// All routes require session auth via requireApiSession.
//
// Doppler API reference for comparison:
// https://docs.doppler.com/reference

import { Spiceflow } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import * as orm from 'drizzle-orm'
import { z } from 'zod'
import * as schema from 'db/src/app-schema.ts'
import {
  getDb,
  requireApiSession,
  requireApiOrgMember,
  requireSecretsApiAuth,
  getOrgIdForProject,
  getOrgIdForEnvironment,
  deriveSecrets,
  encrypt,
  decrypt,
} from './db.ts'

export const apiApp = new Spiceflow()
  .use(openapi({ path: '/api/openapi.json' }))

  // ── Orgs ────────────────────────────────────────────────────────
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

  // ── Projects ────────────────────────────────────────────────────
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

  // ── Environments ────────────────────────────────────────────────
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

  // ── Secrets ─────────────────────────────────────────────────────
  // These routes accept both session cookies and Bearer tokens.
  // Token auth is scoped to a project (and optionally a single environment).
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets',
    async handler({ params, request }) {
      await requireSecretsApiAuth(request, params.environmentId)
      const derived = await deriveSecrets(params.environmentId)
      const secrets = derived.map((d) => ({
        id: d.id, name: d.name,
        createdAt: d.createdAt, updatedAt: d.updatedAt,
      }))
      return { environmentId: params.environmentId, secrets }
    },
  })

  .route({
    method: 'POST',
    path: '/api/environments/:environmentId/secrets',
    request: z.object({ name: z.string().min(1), value: z.string().min(1) }),
    async handler({ request, params }) {
      const body = await request.json()
      const auth = await requireSecretsApiAuth(request, params.environmentId)
      const db = getDb()
      const { encrypted, iv } = await encrypt(body.value)
      const [row] = await db.insert(schema.secretEvent).values({
        environmentId: params.environmentId, name: body.name,
        operation: 'set', valueEncrypted: encrypted, iv,
        userId: auth.userId, apiTokenId: auth.apiTokenId,
      }).returning({ id: schema.secretEvent.id, name: schema.secretEvent.name })
      return { ok: true, environmentId: params.environmentId, id: row!.id, name: row!.name }
    },
  })

  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets/:name',
    async handler({ params, request }) {
      await requireSecretsApiAuth(request, params.environmentId)
      const derived = await deriveSecrets(params.environmentId)
      const secret = derived.find((d) => d.name === params.name)
      if (!secret) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
      const value = await decrypt(secret.valueEncrypted, secret.iv)
      return { id: secret.id, name: secret.name, value, environmentId: params.environmentId, createdAt: secret.createdAt, updatedAt: secret.updatedAt }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:environmentId/secrets/:name',
    async handler({ params, request }) {
      const auth = await requireSecretsApiAuth(request, params.environmentId)
      const db = getDb()
      await db.insert(schema.secretEvent).values({
        environmentId: params.environmentId, name: params.name,
        operation: 'delete', userId: auth.userId, apiTokenId: auth.apiTokenId,
      })
      return { ok: true, name: params.name }
    },
  })

  // ── Bulk download (like Doppler's /secrets/download) ────────────
  // Returns all secrets with decrypted values for an environment.
  // Supports format query param: json (default), env, yaml.
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets/download',
    async handler({ params, request }) {
      await requireSecretsApiAuth(request, params.environmentId)

      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'json'

      const derived = await deriveSecrets(params.environmentId)
      const entries: Record<string, string> = {}
      for (const d of derived) {
        entries[d.name] = await decrypt(d.valueEncrypted, d.iv)
      }

      if (format === 'env') {
        const lines = Object.entries(entries).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        return new Response(lines.join('\n') + '\n', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }

      if (format === 'yaml') {
        const lines = Object.entries(entries).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        return new Response(lines.join('\n') + '\n', {
          headers: { 'content-type': 'text/yaml; charset=utf-8' },
        })
      }

      // Default: json
      return entries
    },
  })

  // ── Bulk set (like Doppler's POST /secrets with secrets object) ──
  // Accepts { secrets: { KEY: "value", ... } } and sets all at once.
  .route({
    method: 'PUT',
    path: '/api/environments/:environmentId/secrets',
    request: z.object({ secrets: z.record(z.string(), z.string()) }),
    async handler({ request, params }) {
      const body = await request.json()
      const auth = await requireSecretsApiAuth(request, params.environmentId)
      const db = getDb()

      const names: string[] = []
      for (const [name, value] of Object.entries(body.secrets)) {
        const { encrypted, iv } = await encrypt(value)
        await db.insert(schema.secretEvent).values({
          environmentId: params.environmentId, name,
          operation: 'set', valueEncrypted: encrypted, iv,
          userId: auth.userId, apiTokenId: auth.apiTokenId,
        })
        names.push(name)
      }
      return { ok: true, environmentId: params.environmentId, secrets: names }
    },
  })

  // ── Health ──────────────────────────────────────────────────────
  .get('/health', () => {
    return { ok: true, service: 'sigillo-app' }
  })
