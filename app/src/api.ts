// REST API for external consumers (CLI, SDKs, agents).
// Mounted as a sub-app in app.tsx via .use(apiApp).
// All routes require session auth via requireApiSession.
//
// Doppler API reference for comparison:
// https://docs.doppler.com/reference

import { ulid } from 'ulid'
import { Spiceflow, json } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import * as orm from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod'
import { z } from 'zod'
import * as schema from 'db/src/app-schema.ts'
import {
  getDb,
  getDataCenter,
  requireApiSession,
  requireApiOrgMember,
  requireSecretsApiAuth,
  getOrgIdForProject,
  getOrgIdForEnvironment,
  deriveSecrets,
  encrypt,
  decrypt,
} from './db.ts'

const userSelectSchema = createSelectSchema(schema.user)
const orgSelectSchema = createSelectSchema(schema.org)
const orgMemberSelectSchema = createSelectSchema(schema.orgMember)
const projectSelectSchema = createSelectSchema(schema.project)
const environmentSelectSchema = createSelectSchema(schema.environment)
const secretEventSelectSchema = createSelectSchema(schema.secretEvent)

const projectCreateRequestSchema = createInsertSchema(schema.project).pick({
  name: true,
  orgId: true,
})

const environmentCreateRequestSchema = createInsertSchema(
  schema.environment,
).pick({
  name: true,
  slug: true,
})

const orgSummarySchema = orgSelectSchema
  .pick({ id: true, name: true, createdAt: true, updatedAt: true })
  .extend({ role: orgMemberSelectSchema.shape.role })

const orgListResponseSchema = z.object({
  orgs: z.array(orgSummarySchema),
})

const meUserSchema = userSelectSchema.pick({ id: true, name: true, email: true })

const meOrgSchema = orgSelectSchema
  .pick({ id: true, name: true })
  .extend({ role: orgMemberSelectSchema.shape.role })

const meResponseSchema = z.object({
  user: meUserSchema,
  orgs: z.array(meOrgSchema),
})

const environmentSummarySchema = environmentSelectSchema.pick({
  id: true,
  projectId: true,
  name: true,
  slug: true,
  createdAt: true,
  updatedAt: true,
})

const environmentListResponseSchema = z.object({
  projectId: z.string(),
  environments: z.array(environmentSummarySchema),
})

const environmentMutationResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  projectId: z.string(),
})

const environmentDeleteResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
})

const projectSummarySchema = projectSelectSchema.pick({
  id: true,
  orgId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
})

const projectListItemSchema = projectSummarySchema.extend({
  environments: z.array(environmentSummarySchema),
})

const projectListResponseSchema = z.object({
  projects: z.array(projectListItemSchema),
})

const projectMutationResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
})

const projectDeleteResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
})

const secretSummarySchema = secretEventSelectSchema
  .pick({ id: true, name: true, createdAt: true })
  .extend({ updatedAt: z.number() })

const secretListResponseSchema = z.object({
  environmentId: z.string(),
  secrets: z.array(secretSummarySchema),
})

const secretValueResponseSchema = secretSummarySchema.extend({
  value: z.string(),
  environmentId: secretEventSelectSchema.shape.environmentId,
})

const secretMutationResponseSchema = z.object({
  ok: z.literal(true),
  environmentId: z.string(),
  id: z.string(),
  name: z.string(),
})

const secretDeleteResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
})

const bulkSecretsResponseSchema = z.object({
  ok: z.literal(true),
  environmentId: z.string(),
  secrets: z.array(z.string()),
})

const downloadedSecretsFormats = [
  'json',
  'env',
  'env-no-quotes',
  'xargs',
  'yaml',
  'docker',
  'dotnet-json',
] as const
const downloadedSecretsFormatSchema = z.enum(downloadedSecretsFormats)
const downloadedSecretsSchema = z.record(z.string(), z.string())
const errorResponseSchema = z.object({ error: z.string() })

type DotnetJsonValue = string | { [key: string]: DotnetJsonValue }

function toDotnetJsonKey(segment: string) {
  return segment
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_, _separator: string, char: string) =>
      char.toUpperCase(),
    )
}

function renderTextDownload(lines: string[], contentType = 'text/plain; charset=utf-8') {
  return new Response(lines.join('\n') + '\n', {
    headers: { 'content-type': contentType },
  })
}

function renderKeyValueDownload(
  entries: Record<string, string>,
  renderValue: (value: string) => string,
) {
  return renderTextDownload(
    Object.entries(entries).map(([key, value]) => `${key}=${renderValue(value)}`),
  )
}

function buildDotnetJson(entries: Record<string, string>): DotnetJsonValue | Error {
  const root: { [key: string]: DotnetJsonValue } = {}

  for (const [rawKey, value] of Object.entries(entries)) {
    const path = rawKey.split('__').map(toDotnetJsonKey)
    let current = root

    for (const key of path.slice(0, -1)) {
      const existing = current[key]
      if (existing == null) {
        const next: { [key: string]: DotnetJsonValue } = {}
        current[key] = next
        current = next
        continue
      }

      if (typeof existing === 'string') {
        return new Error(
          `dotnet-json format conflict: ${rawKey} overlaps with an existing scalar key`,
        )
      }

      current = existing
    }

    const leafKey = path[path.length - 1]!
    const existing = current[leafKey]
    if (existing != null && typeof existing !== 'string') {
      return new Error(
        `dotnet-json format conflict: ${rawKey} overlaps with an existing object key`,
      )
    }

    current[leafKey] = value
  }

  return root
}

function renderDownloadedSecrets(
  entries: Record<string, string>,
  format: z.infer<typeof downloadedSecretsFormatSchema>,
) {
  if (format === 'json') return entries

  if (format === 'env') {
    return renderKeyValueDownload(entries, (value) => JSON.stringify(value))
  }

  if (format === 'env-no-quotes') {
    return renderKeyValueDownload(entries, (value) => value)
  }

  if (format === 'xargs') {
    const encoder = new TextEncoder()
    const chunks: Uint8Array[] = []
    let totalLength = 0
    for (const [key, value] of Object.entries(entries)) {
      const keyBytes = encoder.encode(key)
      const valueBytes = encoder.encode(value)
      chunks.push(keyBytes, new Uint8Array([0]), valueBytes, new Uint8Array([0]))
      totalLength += keyBytes.length + valueBytes.length + 2
    }

    const output = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      output.set(chunk, offset)
      offset += chunk.length
    }

    return new Response(output, {
      headers: { 'content-type': 'application/octet-stream' },
    })
  }

  if (format === 'docker') {
    return renderKeyValueDownload(entries, (value) => value.replace(/\n/g, '\\n'))
  }

  if (format === 'yaml') {
    return renderTextDownload(
      Object.entries(entries).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
      'text/yaml; charset=utf-8',
    )
  }

  const dotnetJson = buildDotnetJson(entries)
  if (dotnetJson instanceof Error) return dotnetJson

  return new Response(JSON.stringify(dotnetJson, null, 2) + '\n', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

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
      const orgId = ulid()
      const [[org]] = await db.batch([
        db.insert(schema.org).values({ id: orgId, name: body.name }).returning({ id: schema.org.id, name: schema.org.name }),
        db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
      ] as const)
    },
  })

  .route({
    method: 'GET',
    path: '/api/orgs',
    response: orgListResponseSchema,
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
    request: projectCreateRequestSchema,
    response: projectMutationResponseSchema,
    async handler({ request }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      await requireApiOrgMember(session.userId, body.orgId)
      const db = getDb()
      const projectId = ulid()
      const [[proj]] = await db.batch([
        db.insert(schema.project).values({ id: projectId, name: body.name, orgId: body.orgId })
          .returning({ id: schema.project.id, name: schema.project.name, orgId: schema.project.orgId }),
        ...schema.DEFAULT_ENVIRONMENTS.map((e) =>
          db.insert(schema.environment).values({ projectId, name: e.name, slug: e.slug }),
        ),
      ] as const)
      return { ok: true, ...proj! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/projects',
    query: z.object({ orgId: z.string().min(1) }),
    response: projectListResponseSchema,
    async handler({ request, query }) {
      const orgId = query.orgId
      const session = await requireApiSession(request)
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const projects = (await db.query.project.findMany({ where: { orgId }, with: { environments: true }, orderBy: { createdAt: 'desc' } })).map((project) => ({
        id: project.id,
        orgId: project.orgId,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        environments: project.environments.map((environment) => ({
          id: environment.id,
          projectId: environment.projectId,
          name: environment.name,
          slug: environment.slug,
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
        })),
      }))
      return { projects }
    },
  })

  .route({
    method: 'GET',
    path: '/api/projects/:id',
    response: { 200: projectListItemSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const project = await db.query.project.findFirst({
        where: { id: params.id },
        with: { environments: true },
      })
      if (!project) return json({ error: 'not found' }, { status: 404 })
      return {
        id: project.id,
        orgId: project.orgId,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        environments: project.environments.map((environment) => ({
          id: environment.id,
          projectId: environment.projectId,
          name: environment.name,
          slug: environment.slug,
          createdAt: environment.createdAt,
          updatedAt: environment.updatedAt,
        })),
      }
    },
  })

  .route({
    method: 'PATCH',
    path: '/api/projects/:id',
    request: projectCreateRequestSchema.pick({ name: true }),
    response: { 200: projectMutationResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [updated] = await db.update(schema.project)
        .set({ name: body.name, updatedAt: Date.now() })
        .where(orm.eq(schema.project.id, params.id))
        .returning({ id: schema.project.id, orgId: schema.project.orgId, name: schema.project.name })
      if (!updated) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, ...updated }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/projects/:id',
    response: { 200: projectDeleteResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [deleted] = await db.delete(schema.project).where(orm.eq(schema.project.id, params.id)).returning({ id: schema.project.id })
      if (!deleted) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── Environments ────────────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/projects/:projectId/environments',
    response: { 200: environmentListResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const environments = (await db.query.environment.findMany({ where: { projectId: params.projectId }, orderBy: { createdAt: 'asc' } })).map((environment) => ({
        id: environment.id,
        projectId: environment.projectId,
        name: environment.name,
        slug: environment.slug,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      }))
      return { projectId: params.projectId, environments }
    },
  })

  .route({
    method: 'POST',
    path: '/api/projects/:projectId/environments',
    request: environmentCreateRequestSchema,
    response: { 200: environmentMutationResponseSchema, 404: errorResponseSchema },
    async handler({ request, params }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [row] = await db.insert(schema.environment).values({ projectId: params.projectId, name: body.name, slug: body.slug })
        .returning({ id: schema.environment.id, projectId: schema.environment.projectId, name: schema.environment.name, slug: schema.environment.slug })
      return { ok: true, ...row! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/environments/:id',
    response: { 200: environmentSummarySchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const environment = await db.query.environment.findFirst({ where: { id: params.id } })
      if (!environment) return json({ error: 'not found' }, { status: 404 })
      return {
        id: environment.id,
        projectId: environment.projectId,
        name: environment.name,
        slug: environment.slug,
        createdAt: environment.createdAt,
        updatedAt: environment.updatedAt,
      }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:id',
    response: { 200: environmentDeleteResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const [deleted] = await db.delete(schema.environment).where(orm.eq(schema.environment.id, params.id)).returning({ id: schema.environment.id })
      if (!deleted) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  .route({
    method: 'PATCH',
    path: '/api/environments/:id',
    request: environmentCreateRequestSchema.partial(),
    response: { 200: environmentMutationResponseSchema, 400: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const body = await request.json()
      if (!body.name && !body.slug) {
        return json({ error: 'at least one of name or slug required' }, { status: 400 })
      }
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForEnvironment(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      await requireApiOrgMember(session.userId, orgId)
      const db = getDb()
      const updates: Partial<{ name: string; slug: string; updatedAt: number }> = { updatedAt: Date.now() }
      if (body.name) updates.name = body.name
      if (body.slug) updates.slug = body.slug
      const [updated] = await db.update(schema.environment).set(updates).where(orm.eq(schema.environment.id, params.id))
        .returning({ id: schema.environment.id, projectId: schema.environment.projectId, name: schema.environment.name, slug: schema.environment.slug })
      if (!updated) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, ...updated }
    },
  })

  // ── Secrets ─────────────────────────────────────────────────────
  // These routes accept both session cookies and Bearer tokens.
  // Token auth is scoped to a project (and optionally a single environment).
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets',
    response: secretListResponseSchema,
    async handler({ params, request }): Promise<any> {
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
    response: secretMutationResponseSchema,
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
    response: { 200: secretValueResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      await requireSecretsApiAuth(request, params.environmentId)
      const derived = await deriveSecrets(params.environmentId)
      const secret = derived.find((d) => d.name === params.name)
      if (!secret) return json({ error: 'not found' }, { status: 404 })
      const value = await decrypt(secret.valueEncrypted, secret.iv)
      return { id: secret.id, name: secret.name, value, environmentId: params.environmentId, createdAt: secret.createdAt, updatedAt: secret.updatedAt }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/environments/:environmentId/secrets/:name',
    response: secretDeleteResponseSchema,
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
  // Supports format query param: json (default), env, env-no-quotes,
  // xargs, yaml, docker, dotnet-json.
  .route({
    method: 'GET',
    path: '/api/environments/:environmentId/secrets/download',
    query: z.object({ format: downloadedSecretsFormatSchema.optional() }),
    async handler({ params, request, query }) {
      await requireSecretsApiAuth(request, params.environmentId)

      const format = query.format || 'json'

      const derived = await deriveSecrets(params.environmentId)
      const entries: Record<string, string> = {}
      for (const d of derived) {
        entries[d.name] = await decrypt(d.valueEncrypted, d.iv)
      }

      const rendered = renderDownloadedSecrets(entries, format)
      if (rendered instanceof Error) {
        throw json({ error: rendered.message }, { status: 400 })
      }
      return rendered
    },
  })

  // ── Bulk set (like Doppler's POST /secrets with secrets object) ──
  // Accepts { secrets: { KEY: "value", ... } } and sets all at once.
  .route({
    method: 'PUT',
    path: '/api/environments/:environmentId/secrets',
    request: z.object({ secrets: z.record(z.string(), z.string()) }),
    response: bulkSecretsResponseSchema,
    async handler({ request, params }) {
      const body = await request.json()
      const auth = await requireSecretsApiAuth(request, params.environmentId)
      const db = getDb()

      const entries = Object.entries(body.secrets)
      const encrypted = await Promise.all(entries.map(([, value]) => encrypt(value)))
      await db.batch(
        entries.map(([name], i) =>
          db.insert(schema.secretEvent).values({
            environmentId: params.environmentId, name,
            operation: 'set', valueEncrypted: encrypted[i]!.encrypted, iv: encrypted[i]!.iv,
            userId: auth.userId, apiTokenId: auth.apiTokenId,
          }),
        ) as [any, ...any[]],
      )
      return { ok: true, environmentId: params.environmentId, secrets: entries.map(([name]) => name) }
    },
  })

  // ── Me ───────────────────────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/me',
    response: meResponseSchema,
    async handler({ request }) {
      const session = await requireApiSession(request)
      const db = getDb()
      const members = await db.query.orgMember.findMany({
        where: { userId: session.userId },
        with: { org: true },
      })
      const orgs = members.filter((m) => m.org != null).map((m) => ({
        id: m.org!.id!, name: m.org!.name!, role: m.role,
      }))
      return {
        user: {
          id: session.user.id,
          name: session.user.name ?? '',
          email: session.user.email ?? '',
        },
        orgs,
      }
    },
  })

  // ── Info (public) ───────────────────────────────────────────────
  // Returns the IATA colo code of the Durable Object's data center.
  // Used by the UI footer to display "database in <region>".
  .get('/api/info', async () => {
    const colo = await getDataCenter()
    return { colo }
  })

  // ── Health ──────────────────────────────────────────────────────
  .get('/health', () => {
    return { ok: true, service: 'sigillo-app' }
  })
