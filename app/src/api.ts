// REST API for external consumers (CLI, SDKs, agents).
// Mounted as a sub-app in app.tsx via .use(apiApp).
// Session routes use requireApiSession. Secrets routes also accept sig_
// tokens via requireSecretsApiAuth. Read routes for me, orgs, projects,
// and environments accept those tokens so CLI setup and inspection work.
//
// Doppler API reference for comparison:
// https://docs.doppler.com/reference

import { ulid } from 'ulid'
import { Spiceflow, json } from 'spiceflow'
import { openapi } from 'spiceflow/openapi'
import * as orm from 'drizzle-orm'
import { createInsertSchema, createSelectSchema } from 'drizzle-orm/zod'
import { z } from 'zod'
import { schema } from 'db'
import {
  getDb,
  getDataCenter,
  requireApiSession,
  requireApiOrgMember,
  requireSecretsApiAuth,
  getRequestApiToken,
  getOrgIdForProject,
  getOrgIdForEnvironment,
  getProjectIdForEnvironment,
  resolveEnvironment,
  deriveSecrets,
  deriveEnvironmentSecretsAndNames,
  encrypt,
  decrypt,
  getEmailDomain,
  COMMON_EMAIL_DOMAINS,
  getMemberProjectAccess,
  getAccessibleProjectIds,
  getUserEnvironmentAccess,
  getMemberAccess,
  getReadableEnvironmentIds,
  getRequestOrigin,
  ForbiddenError,
} from './db.ts'
import {
  APPROVAL_LABEL_MAX_LENGTH,
  addToPendingRequest,
  approvalRequiredBody,
  getApprovalUrl,
  getRequestState,
  requestReadApproval,
} from './approvals.ts'
import { memoize } from './lib/memoize.ts'
import { ENV_DESCRIPTION_MAX_LENGTH, SECRET_NAME_REGEX, isRenderableSecretName, renderEnvFile } from './lib/utils.ts'

// Latest GitHub release carrying a self-host bundle asset. Memoized via the
// Cache API so the GitHub API is hit at most every few minutes.
const fetchLatestSelfhostRelease = memoize({
  namespace: 'selfhost-release',
  fn: async (): Promise<{ version: string; url: string } | null> => {
    const res = await fetch('https://api.github.com/repos/remorses/sigillo/releases?per_page=30', {
      headers: { 'User-Agent': 'sigillo-app', Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const releases: Array<{
      tag_name: string
      assets: Array<{ name: string; browser_download_url: string }>
    }> = await res.json()
    for (const release of releases) {
      const asset = release.assets.find((a) => a.name === 'sigillo-selfhost-bundle.json.gz')
      if (asset && release.tag_name.startsWith('sigillo@')) {
        return { version: release.tag_name.slice('sigillo@'.length), url: asset.browser_download_url }
      }
    }
    return null
  },
})

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

const environmentCreateRequestSchema = createInsertSchema(schema.environment, {
  description: (s) => s.trim().max(ENV_DESCRIPTION_MAX_LENGTH).optional(),
}).pick({
  name: true,
  slug: true,
  description: true,
})

const orgSummarySchema = orgSelectSchema
  .pick({ id: true, name: true, createdAt: true, updatedAt: true })
  .extend({ role: orgMemberSelectSchema.shape.role })

const orgListResponseSchema = z.object({
  orgs: z.array(orgSummarySchema),
})

const orgMutationResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  name: z.string(),
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
  description: true,
  createdAt: true,
  updatedAt: true,
})

const environmentListResponseSchema = z.object({
  projectId: z.string(),
  environments: z.array(environmentSummarySchema),
})

const environmentMutationResponseSchema = environmentSummarySchema
  .pick({ id: true, projectId: true, name: true, slug: true, description: true })
  .extend({ ok: z.literal(true) })

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
  orgName: z.string(),
  environments: z.array(environmentSummarySchema),
})

type ProjectWithOrgAndEnvs = {
  id: string
  orgId: string
  name: string
  createdAt: number
  updatedAt: number
  org?: { name: string } | null
  environments: Array<z.infer<typeof environmentSummarySchema>>
}

function toEnvironmentSummary(environment: z.infer<typeof environmentSummarySchema>) {
  return {
    id: environment.id,
    projectId: environment.projectId,
    name: environment.name,
    slug: environment.slug,
    description: environment.description,
    createdAt: environment.createdAt,
    updatedAt: environment.updatedAt,
  }
}

function toProjectPayload(project: ProjectWithOrgAndEnvs, environmentIds?: string[] | null): z.infer<typeof projectListItemSchema> {
  const environments = environmentIds
    ? project.environments.filter((environment) => environmentIds.includes(environment.id))
    : project.environments
  return {
    id: project.id,
    orgId: project.orgId,
    orgName: project.org?.name ?? '',
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    environments: environments.map(toEnvironmentSummary),
  }
}

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

const secretBaseSummarySchema = secretEventSelectSchema
  .pick({ id: true, name: true, createdAt: true })
  .extend({ updatedAt: z.number() })

const secretListItemSchema = secretBaseSummarySchema.extend({
  isEmpty: z.boolean(),
})

const secretListResponseSchema = z.object({
  environmentId: z.string(),
  secrets: z.array(secretListItemSchema),
  allNames: z.array(z.string()),
})

const secretValueResponseSchema = secretBaseSummarySchema.extend({
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

const secretNameSchema = z.string().regex(SECRET_NAME_REGEX, 'Secret names must use letters, digits and underscores, not starting with a digit')

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

const approvalRequestSchema = z.object({
  label: z.string().trim().max(APPROVAL_LABEL_MAX_LENGTH).optional(),
  items: z.array(z.object({
    projectId: z.string().min(1),
    // Environment id or slug.
    environment: z.string().min(1),
    // Omit to ask for every secret of the environment.
    secrets: z.array(z.string().min(1)).min(1).optional(),
  })).min(1).max(50),
})

// `id` and `url` are '' when nothing needs approval (status 'approved').
const approvalResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'revoked', 'expired']),
  expiresAt: z.number(),
})

// Session access to an environment (org member, project, admin-only role).
async function requireApiEnvironmentAccess({ userId, environmentRef, projectId }: { userId: string; environmentRef: string; projectId: string }) {
  const env = await getUserEnvironmentAccess({ userId, environmentRef, projectId }).catch((error) => {
    if (error instanceof ForbiddenError) throw json({ error: error.message }, { status: 403 })
    throw error
  })
  if (!env) throw json({ error: 'not found' }, { status: 404 })
  return env
}

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
    Object.entries(entries)
      .filter(([key]) => isRenderableSecretName(key))
      .map(([key, value]) => `${key}=${renderValue(value)}`),
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
    return new Response(renderEnvFile(Object.entries(entries)), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
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
      Object.entries(entries)
        .filter(([key]) => isRenderableSecretName(key))
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
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
  .use(openapi({ path: '/api/v0/openapi.json' }))

  // ── Orgs ────────────────────────────────────────────────────────
  .route({
    method: 'POST',
    path: '/api/v0/orgs',
    detail: { tags: ['Organizations'], summary: 'Create organization' },
    request: z.object({ name: z.string().min(1), enableAutoJoin: z.boolean().optional() }),
    response: orgMutationResponseSchema,
    async handler({ request }) {
      const body = await request.json()
      const session = await requireApiSession(request)

      let autoJoinDomain: string | null = null
      if (body.enableAutoJoin) {
        if (!session.user.emailVerified) {
          throw json({ error: 'Email must be verified to enable auto-join' }, { status: 400 })
        }
        const domain = getEmailDomain(session.user.email)
        if (!domain || COMMON_EMAIL_DOMAINS.has(domain)) {
          throw json({ error: 'Cannot enable auto-join for public email domains' }, { status: 400 })
        }
        autoJoinDomain = domain
      }

      const db = getDb()
      const orgId = ulid()
      const [[org]] = await db.batch([
        db.insert(schema.org).values({ id: orgId, name: body.name, autoJoinDomain }).returning({ id: schema.org.id, name: schema.org.name }),
        db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
      ] as const)
      return { ok: true as const, id: org!.id!, name: org!.name! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/v0/orgs',
    detail: { tags: ['Organizations'], summary: 'List organizations' },
    response: orgListResponseSchema,
    async handler({ request }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        const db = getDb()
        const project = await db.query.project.findFirst({
          where: { id: apiToken.projectId },
          with: { org: true },
        })
        if (!project?.org) return { orgs: [] }
        return {
          orgs: [{
            id: project.org.id,
            name: project.org.name,
            role: 'member' as const,
            createdAt: project.org.createdAt,
            updatedAt: project.org.updatedAt,
          }],
        }
      }

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
    path: '/api/v0/projects',
    detail: { tags: ['Projects'], summary: 'Create project' },
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
    path: '/api/v0/projects',
    detail: { tags: ['Projects'], summary: 'List projects' },
    query: z.object({ orgId: z.string().min(1).optional() }),
    response: projectListResponseSchema,
    async handler({ request, query }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        const db = getDb()
        const project = await db.query.project.findFirst({
          where: { id: apiToken.projectId },
          with: { org: true, environments: true },
        })
        if (!project || (query.orgId && project.orgId !== query.orgId)) return { projects: [] }
        return { projects: [toProjectPayload(project, apiToken.environmentIds)] }
      }

      const session = await requireApiSession(request)
      const db = getDb()

      const memberships = await db.query.orgMember.findMany({
        where: query.orgId ? { userId: session.userId, orgId: query.orgId } : { userId: session.userId },
        with: {
          org: {
            with: {
              projects: {
                with: { environments: true },
                orderBy: { createdAt: 'desc' },
              },
            },
          },
        },
      })

      if (query.orgId && memberships.length === 0) {
        await requireApiOrgMember(session.userId, query.orgId)
      }

      const projects: z.infer<typeof projectListItemSchema>[] = []
      for (const membership of memberships) {
        if (!membership.org) continue
        const org = membership.org
        const accessibleIds = await getAccessibleProjectIds(session.userId, org.id)
        for (const project of org.projects) {
          // If member has scoped access, skip projects not in their list
          if (accessibleIds !== null && !accessibleIds.includes(project.id)) continue
          projects.push(toProjectPayload({ ...project, org }))
        }
      }
      return { projects }
    },
  })

  .route({
    method: 'GET',
    path: '/api/v0/projects/:id',
    detail: { tags: ['Projects'], summary: 'Get project' },
    response: { 200: projectListItemSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        if (apiToken.projectId !== params.id) return json({ error: 'forbidden' }, { status: 403 })
        const db = getDb()
        const project = await db.query.project.findFirst({
          where: { id: params.id },
          with: { org: true, environments: true },
        })
        if (!project) return json({ error: 'not found' }, { status: 404 })
        return toProjectPayload(project, apiToken.environmentIds)
      }

      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      // getMemberProjectAccess also verifies org membership (single query),
      // so no separate requireApiOrgMember round-trip is needed.
      if (!await getMemberProjectAccess({ userId: session.userId, orgId, projectId: params.id })) return json({ error: 'forbidden' }, { status: 403 })
      const db = getDb()
      const project = await db.query.project.findFirst({
        where: { id: params.id },
        with: { org: true, environments: true },
      })
      if (!project) return json({ error: 'not found' }, { status: 404 })
      return toProjectPayload(project)
    },
  })

  .route({
    method: 'PATCH',
    path: '/api/v0/projects/:id',
    detail: { tags: ['Projects'], summary: 'Update project' },
    request: projectCreateRequestSchema.pick({ name: true }),
    response: { 200: projectMutationResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      // getMemberProjectAccess also verifies org membership (single query),
      // so no separate requireApiOrgMember round-trip is needed.
      if (!await getMemberProjectAccess({ userId: session.userId, orgId, projectId: params.id })) return json({ error: 'forbidden' }, { status: 403 })
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
    path: '/api/v0/projects/:id',
    detail: { tags: ['Projects'], summary: 'Delete project' },
    response: { 200: projectDeleteResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.id)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      // getMemberProjectAccess also verifies org membership (single query),
      // so no separate requireApiOrgMember round-trip is needed.
      const access = await getMemberAccess({ userId: session.userId, orgId })
      if (!access || (access.accessibleProjectIds !== null && !access.accessibleProjectIds.includes(params.id))) {
        return json({ error: 'forbidden' }, { status: 403 })
      }
      const db = getDb()
      // Deleting a project deletes its environments, so an admin-only one needs an admin.
      if (access?.role !== 'admin') {
        const adminOnly = await db.query.environment.findFirst({ where: { projectId: params.id, accessRole: 'admin' }, columns: { id: true } })
        if (adminOnly) return json({ error: 'admin access required for this environment' }, { status: 403 })
      }
      const [deleted] = await db.delete(schema.project).where(orm.eq(schema.project.id, params.id)).returning({ id: schema.project.id })
      if (!deleted) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  // ── Environments ────────────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/v0/projects/:projectId/environments',
    detail: { tags: ['Environments'], summary: 'List environments' },
    response: { 200: environmentListResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        if (apiToken.projectId !== params.projectId) return json({ error: 'forbidden' }, { status: 403 })
        const db = getDb()
        const environments = (await db.query.environment.findMany({
          where: apiToken.environmentIds
            ? { projectId: params.projectId, id: { in: apiToken.environmentIds } }
            : { projectId: params.projectId },
          orderBy: { createdAt: 'asc' },
        })).map(toEnvironmentSummary)
        return { projectId: params.projectId, environments }
      }

      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      if (!await getMemberProjectAccess({ userId: session.userId, orgId, projectId: params.projectId })) {
        return json({ error: 'forbidden' }, { status: 403 })
      }
      const db = getDb()
      const environments = (await db.query.environment.findMany({ where: { projectId: params.projectId }, orderBy: { createdAt: 'asc' } })).map(toEnvironmentSummary)
      return { projectId: params.projectId, environments }
    },
  })

  .route({
    method: 'POST',
    path: '/api/v0/projects/:projectId/environments',
    detail: { tags: ['Environments'], summary: 'Create environment' },
    request: environmentCreateRequestSchema,
    response: { 200: environmentMutationResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ request, params }) {
      const body = await request.json()
      const session = await requireApiSession(request)
      const orgId = await getOrgIdForProject(params.projectId)
      if (!orgId) return json({ error: 'not found' }, { status: 404 })
      if (!await getMemberProjectAccess({ userId: session.userId, orgId, projectId: params.projectId })) {
        return json({ error: 'forbidden' }, { status: 403 })
      }
      const db = getDb()
      const [row] = await db.insert(schema.environment).values({ projectId: params.projectId, name: body.name, slug: body.slug, description: body.description })
        .returning({ id: schema.environment.id, projectId: schema.environment.projectId, name: schema.environment.name, slug: schema.environment.slug, description: schema.environment.description })
      return { ok: true, ...row! }
    },
  })

  .route({
    method: 'GET',
    path: '/api/v0/projects/:projectId/environments/:id',
    detail: { tags: ['Environments'], summary: 'Get environment' },
    response: { 200: environmentSummarySchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        if (apiToken.projectId !== params.projectId) return json({ error: 'forbidden' }, { status: 403 })
        const environment = await resolveEnvironment(params.id, params.projectId)
        if (!environment || environment.projectId !== apiToken.projectId) return json({ error: 'not found' }, { status: 404 })
        if (apiToken.environmentIds && !apiToken.environmentIds.includes(environment.id)) {
          return json({ error: 'forbidden' }, { status: 403 })
        }
        return toEnvironmentSummary(environment)
      }

      const session = await requireApiSession(request)
      const environment = await resolveEnvironment(params.id, params.projectId)
      if (!environment?.orgId) return json({ error: 'not found' }, { status: 404 })
      // Metadata only, so project access is enough (same as the list route).
      if (!await getMemberProjectAccess({ userId: session.userId, orgId: environment.orgId, projectId: environment.projectId })) {
        return json({ error: 'forbidden' }, { status: 403 })
      }
      return toEnvironmentSummary(environment)
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/v0/projects/:projectId/environments/:id',
    detail: { tags: ['Environments'], summary: 'Delete environment' },
    response: { 200: environmentDeleteResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const session = await requireApiSession(request)
      const environment = await requireApiEnvironmentAccess({ userId: session.userId, environmentRef: params.id, projectId: params.projectId })
      const db = getDb()
      const [deleted] = await db.delete(schema.environment).where(orm.eq(schema.environment.id, environment.id)).returning({ id: schema.environment.id })
      if (!deleted) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, id: deleted.id }
    },
  })

  .route({
    method: 'PATCH',
    path: '/api/v0/projects/:projectId/environments/:id',
    detail: { tags: ['Environments'], summary: 'Update environment' },
    request: environmentCreateRequestSchema.partial(),
    response: { 200: environmentMutationResponseSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const body = await request.json()
      if (!body.name && !body.slug && body.description === undefined) {
        return json({ error: 'at least one of name, slug or description required' }, { status: 400 })
      }
      const session = await requireApiSession(request)
      const environment = await requireApiEnvironmentAccess({ userId: session.userId, environmentRef: params.id, projectId: params.projectId })
      const db = getDb()
      const updates: Partial<{ name: string; slug: string; description: string; updatedAt: number }> = { updatedAt: Date.now() }
      if (body.name) updates.name = body.name
      if (body.slug) updates.slug = body.slug
      if (body.description !== undefined) updates.description = body.description
      const [updated] = await db.update(schema.environment).set(updates).where(orm.eq(schema.environment.id, environment.id))
        .returning({ id: schema.environment.id, projectId: schema.environment.projectId, name: schema.environment.name, slug: schema.environment.slug, description: schema.environment.description })
      if (!updated) return json({ error: 'not found' }, { status: 404 })
      return { ok: true, ...updated }
    },
  })

  // ── Secrets ─────────────────────────────────────────────────────
  // These routes accept both session cookies and Bearer tokens.
  // Token auth is scoped to a project (and optionally an env allowlist).
  .route({
    method: 'GET',
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets',
    detail: { tags: ['Secrets'], summary: 'List secrets' },
    response: secretListResponseSchema,
    async handler({ params, request }): Promise<any> {
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })
      const db = getDb()

      // Derive projectId from the authenticated environment, not the URL param,
      // so a token for project A can't leak allNames from project B's URL.
      const authProjectId = await getProjectIdForEnvironment(auth.environmentId)
      const environmentIds = await getReadableEnvironmentIds(auth, authProjectId!)

      const { secrets: derived, allNames } = await deriveEnvironmentSecretsAndNames({
        environmentIds,
        selectedEnvId: auth.environmentId,
      })

      // Decrypt each value to check if it's empty
      const secrets = await Promise.all(derived.map(async (d) => {
        const value = await decrypt(d.valueEncrypted, d.iv)
        return {
          id: d.id, name: d.name,
          createdAt: d.createdAt, updatedAt: d.updatedAt,
          isEmpty: value === '',
        }
      }))
      return { environmentId: auth.environmentId, secrets, allNames }
    },
  })

  .route({
    method: 'POST',
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets',
    detail: { tags: ['Secrets'], summary: 'Set secret' },
    request: z.object({ name: secretNameSchema, value: z.string() }),
    response: secretMutationResponseSchema,
    async handler({ request, params }) {
      const body = await request.json()
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })
      const db = getDb()
      const { encrypted, iv } = await encrypt(body.value)
      const [row] = await db.insert(schema.secretEvent).values({
        environmentId: auth.environmentId, name: body.name,
        operation: 'set', valueEncrypted: encrypted, iv,
        userId: auth.userId, apiTokenId: auth.apiTokenId,
      }).returning({ id: schema.secretEvent.id, name: schema.secretEvent.name })
      return { ok: true, environmentId: auth.environmentId, id: row!.id, name: row!.name }
    },
  })

  .route({
    method: 'GET',
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets/:name',
    detail: { tags: ['Secrets'], summary: 'Get secret value' },
    response: { 200: secretValueResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })
      const derived = await deriveSecrets(auth.environmentId)
      const secret = derived.find((d) => d.name === params.name)
      if (!secret) return json({ error: 'not found' }, { status: 404 })
      const approval = await requestReadApproval({
        auth, environment: { id: auth.environmentId, readApproval: auth.readApproval },
        names: [secret.name], scope: 'names', origin: getRequestOrigin(request),
      })
      if (approval) throw json(approvalRequiredBody(approval), { status: 403 })
      const value = await decrypt(secret.valueEncrypted, secret.iv)
      return { id: secret.id, name: secret.name, value, environmentId: auth.environmentId, createdAt: secret.createdAt, updatedAt: secret.updatedAt }
    },
  })

  .route({
    method: 'DELETE',
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets/:name',
    detail: { tags: ['Secrets'], summary: 'Delete secret' },
    response: secretDeleteResponseSchema,
    async handler({ params, request }) {
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })
      const db = getDb()
      await db.insert(schema.secretEvent).values({
        environmentId: auth.environmentId, name: params.name,
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
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets/download',
    detail: { tags: ['Secrets'], summary: 'Download secrets' },
    query: z.object({ format: downloadedSecretsFormatSchema.optional() }),
    async handler({ params, request, query }) {
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })

      const format = query.format || 'json'

      const derived = await deriveSecrets(auth.environmentId)
      // All or nothing: a partial download would start apps with missing variables.
      const approval = await requestReadApproval({
        auth, environment: { id: auth.environmentId, readApproval: auth.readApproval },
        names: derived.map((d) => d.name), scope: 'environment', origin: getRequestOrigin(request),
      })
      if (approval) throw json(approvalRequiredBody(approval), { status: 403 })
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
    path: '/api/v0/projects/:projectId/environments/:environmentId/secrets',
    detail: { tags: ['Secrets'], summary: 'Bulk set secrets' },
    request: z.object({ secrets: z.record(secretNameSchema, z.string()) }),
    response: bulkSecretsResponseSchema,
    async handler({ request, params }) {
      const body = await request.json()
      const auth = await requireSecretsApiAuth({ request, environmentRef: params.environmentId, projectId: params.projectId })
      const db = getDb()

      const entries = Object.entries(body.secrets)
      const encrypted = await Promise.all(entries.map(([, value]) => encrypt(value)))
      const [firstInsert, ...restInserts] = entries.map(([name], i) =>
        db.insert(schema.secretEvent).values({
          environmentId: auth.environmentId, name,
          operation: 'set', valueEncrypted: encrypted[i]!.encrypted, iv: encrypted[i]!.iv,
          userId: auth.userId, apiTokenId: auth.apiTokenId,
        }),
      )
      if (firstInsert) await db.batch([firstInsert, ...restInserts])
      return { ok: true, environmentId: auth.environmentId, secrets: entries.map(([name]) => name) }
    },
  })

  // ── Approvals ───────────────────────────────────────────────────
  // A blocked read already adds what it needs to the caller's pending request
  // (see requestReadApproval). This route lets a CLI or agent ask up front for
  // everything it will need, with a label, so the user approves one URL.
  // Calling it again edits the same pending request.
  .route({
    method: 'POST',
    path: '/api/v0/approvals',
    detail: { tags: ['Approvals'], summary: 'Request approval to read protected secrets' },
    request: approvalRequestSchema,
    response: approvalResponseSchema,
    async handler({ request }) {
      const body = await request.json()
      const origin = getRequestOrigin(request)
      let approval: { id: string; url: string; expiresAt: number } | null = null
      let auth: Awaited<ReturnType<typeof requireSecretsApiAuth>> | null = null
      for (const item of body.items) {
        auth = await requireSecretsApiAuth({ request, environmentRef: item.environment, projectId: item.projectId })
        const names = item.secrets ?? (await deriveSecrets(auth.environmentId)).map((d) => d.name)
        approval = await requestReadApproval({
          auth, environment: { id: auth.environmentId, readApproval: auth.readApproval },
          names, scope: item.secrets ? 'names' : 'environment', origin, label: body.label,
        }) ?? approval
      }
      if (!approval) return { id: '', url: '', status: 'approved' as const, expiresAt: 0 }
      // A label alone (every item already covered by an earlier call) still updates the request.
      if (body.label !== undefined && auth) {
        await addToPendingRequest({ credential: auth, requesterId: auth.requesterId, items: [], label: body.label })
      }
      return { id: approval.id, url: approval.url, status: 'pending' as const, expiresAt: approval.expiresAt }
    },
  })

  .route({
    method: 'GET',
    path: '/api/v0/approvals/:id',
    detail: { tags: ['Approvals'], summary: 'Get approval request status' },
    response: { 200: approvalResponseSchema, 404: errorResponseSchema },
    async handler({ params, request }) {
      const apiToken = await getRequestApiToken(request)
      const session = apiToken ? null : await requireApiSession(request)
      const row = await getDb().query.approvalRequest.findFirst({ where: { id: params.id } })
      // Only the credential that asked may poll. Anything else is a 404.
      const owns = row && (apiToken ? row.apiTokenId === apiToken.tokenId : row.sessionId === session!.sessionId)
      if (!row || !owns) return json({ error: 'not found' }, { status: 404 })
      return {
        id: row.id,
        url: getApprovalUrl(getRequestOrigin(request), row.id),
        status: getRequestState(row, Date.now()),
        expiresAt: row.expiresAt,
      }
    },
  })

  // ── Me ───────────────────────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/api/v0/me',
    detail: { tags: ['Auth'], summary: 'Get current user' },
    response: meResponseSchema,
    async handler({ request }) {
      const apiToken = await getRequestApiToken(request)
      if (apiToken) {
        const db = getDb()
        const token = await db.query.apiToken.findFirst({
          where: { id: apiToken.tokenId },
          with: { creator: true, project: { with: { org: true } } },
        })
        if (!token?.creator || !token.project?.org) {
          throw new Response(JSON.stringify({ error: 'unauthorized' }), {
            status: 401, headers: { 'content-type': 'application/json' },
          })
        }
        return {
          user: {
            id: token.creator.id,
            name: token.creator.name ?? '',
            email: token.creator.email ?? '',
          },
          orgs: [{
            id: token.project.org.id,
            name: token.project.org.name,
            role: 'member' as const,
          }],
        }
      }

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
  // Returns the IATA colo code of the worker's data center.
  // Used by the UI footer to display "serving from <region>".
  .route({
    method: 'GET',
    path: '/api/info',
    detail: { hide: true },
    async handler({ request }) {
      const colo = getDataCenter(request)
      return { colo }
    },
  })

  // ── Self-host release (public) ──────────────────────────────────
  // Resolves the latest self-host bundle for `npx sigillo self-host`.
  // The CLI downloads through this endpoint (with a GitHub API fallback)
  // so paid update gating can be added here later without any CLI change.
  .route({
    method: 'GET',
    path: '/api/selfhost/release/latest',
    detail: { hide: true },
    async handler() {
      const info = await fetchLatestSelfhostRelease()
      if (!info) {
        return json({ error: 'No self-host release found' }, { status: 404 })
      }
      return info
    },
  })

  // ── Health ──────────────────────────────────────────────────────
  .route({
    method: 'GET',
    path: '/health',
    detail: { hide: true },
    handler() {
      return { ok: true, service: 'sigillo-app' }
    },
  })
