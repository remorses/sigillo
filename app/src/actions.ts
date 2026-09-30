'use server'
// Directive stays on line 1: spiceflow strips it in vitest only when it is the first statement.

// Shared server actions for the Sigillo app UI.
// Client components import these directly instead of receiving action props.
//
// Every action authenticates via getActionRequest() → getSession() and
// verifies org membership before mutating data. No action accepts a raw
// userId — it always comes from the session cookie.
//
// Every action parses its arguments with a zod schema first. Arguments come
// from the client, and drizzle's relational `where` reads an object value as
// filter operators ({ id: { gt: '0' } } -> id > '0'), so an unchecked id can
// match rows the caller never knew about.
//
// Actions throw on error (caught by ErrorBoundary in the UI) and return
// objects on success. Never return strings or scalar values.

import { ulid } from 'ulid'
import { z } from 'zod'
import { getSecretNameError } from './lib/utils.ts'
import * as orm from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { schema } from 'db'
import { getActionRequest, redirect } from 'spiceflow'
import { router } from 'spiceflow/react'
import {
  getDb, getSession,
  requireOrgMember,
  getOrgIdForProject, getOrgIdForEnvironment,
  encrypt,
  generateApiToken,
  deriveSecrets,
  getEmailDomain,
  COMMON_EMAIL_DOMAINS,
  getMemberProjectAccess,
  getMemberAccess,
  getUserEnvironmentAccess,
  getEnvironmentAccessError,
} from './db.ts'

const idSchema = z.string().min(1)
const idListSchema = z.array(idSchema)
const roleSchema = z.enum(['admin', 'member'])

// Input is typed for callers, but the wire can carry anything. Throws the first
// issue message so UI error states stay readable.
function parseInput<T extends z.ZodType>(schema: T, input: z.input<T>): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'Invalid input')
  return result.data
}

async function requireSession() {
  const request = getActionRequest()
  const session = await getSession(request)
  if (!session) throw new Error('Unauthorized')
  return session
}

// Org member + project access + admin role for admin-only envs.
async function requireEnvironmentAccess(userId: string, environmentId: string) {
  const env = await getUserEnvironmentAccess({ userId, environmentRef: environmentId })
  if (!env) throw new Error('Environment not found')
  return env
}

async function requireProjectAccess(userId: string, projectId: string) {
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  if (!await getMemberProjectAccess({ userId, orgId, projectId })) {
    throw new Error('You do not have access to this project')
  }
  return orgId
}

// A token reads every secret in its scope, so creating or revoking one needs
// access to that whole scope: the listed envs, or every env of the project
// for a project-wide token (no env ids). Admin-only envs added later stay
// safe: token use re-checks that the creator is still an admin.
async function requireTokenScopeAccess({ userId, projectId, environmentIds }: {
  userId: string
  projectId: string
  environmentIds: string[]
}) {
  const orgId = await requireProjectAccess(userId, projectId)
  const [access, envs] = await Promise.all([
    getMemberAccess({ userId, orgId }),
    getDb().query.environment.findMany({
      where: environmentIds.length > 0 ? { projectId, id: { in: environmentIds } } : { projectId },
      columns: { projectId: true, accessRole: true },
    }),
  ])
  if (envs.length < environmentIds.length) throw new Error('Environment not found in this project')
  for (const env of envs) {
    const error = getEnvironmentAccessError(access, env)
    if (error) throw new Error(error)
  }
}

async function requireAdminRole(userId: string, orgId: string) {
  const { role } = await requireOrgMember(userId, orgId)
  if (role !== 'admin') throw new Error('Only admins can manage access')
}

async function ensureAnotherAdminExists(orgId: string, userId: string) {
  const db = getDb()
  const admins = await db.query.orgMember.findMany({
    where: { orgId, role: 'admin' },
    columns: { userId: true },
  })
  if (admins.length === 1 && admins[0]?.userId === userId) {
    throw new Error('This organization needs at least one admin')
  }
}

const createProjectInput = z.object({
  name: z.string().min(1, 'Name is required'),
  orgId: z.string().min(1, 'No org selected'),
})

export async function createProjectAction(input: z.input<typeof createProjectInput>) {
  const { name, orgId } = parseInput(createProjectInput, input)
  const session = await requireSession()
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  const projectId = ulid()
  const [[proj]] = await db.batch([
    db.insert(schema.project).values({ id: projectId, name, orgId })
      .returning({ id: schema.project.id, name: schema.project.name }),
    ...schema.DEFAULT_ENVIRONMENTS.map((e) =>
      db.insert(schema.environment).values({ projectId, name: e.name, slug: e.slug }),
    ),
  ] as const)
  throw redirect(router.href('/dash/projects/:projectId', { projectId: proj!.id }))
}

// All secret mutations append to the secretEvent log. Never update or delete events.

const deleteSecretInput = z.object({ name: z.string().min(1), environmentIds: idListSchema })

export async function deleteSecretAction(input: z.input<typeof deleteSecretInput>) {
  const { name, environmentIds } = parseInput(deleteSecretInput, input)
  const unique = Array.from(new Set(environmentIds))
  if (!unique.length) throw new Error('No environments selected')
  const session = await requireSession()
  const envs = await Promise.all(unique.map((id) => requireEnvironmentAccess(session.userId, id)))
  if (envs.some((env) => env.projectId !== envs[0]!.projectId)) {
    throw new Error('All environments must belong to the same project')
  }
  const db = getDb()
  const queries: BatchItem<'sqlite'>[] = unique.map((envId) =>
    db.insert(schema.secretEvent).values({
      environmentId: envId, name, operation: 'delete', userId: session.userId,
    }),
  )
  const [first, ...rest] = queries
  if (first) await db.batch([first, ...rest])
}

// Save edited secrets to the current environment and optionally apply
// the same changes to additional environments. Each edit appends a "set"
// event to the log. Renames are handled as delete old name + set new name.
const saveSecretsInput = z.object({
  edits: z.array(z.object({ name: z.string(), originalName: z.string().optional(), value: z.string() })),
  environmentIds: idListSchema,
})

export async function saveSecretsAction(input: z.input<typeof saveSecretsInput>) {
  const { edits, environmentIds } = parseInput(saveSecretsInput, input)
  if (edits.length === 0 || environmentIds.length === 0) return
  const session = await requireSession()
  const currentEnvId = environmentIds[0]!
  const envs = await Promise.all(
    Array.from(new Set(environmentIds)).map((id) => requireEnvironmentAccess(session.userId, id)),
  )
  if (envs.some((env) => env.projectId !== envs[0]!.projectId)) {
    throw new Error('All environments must belong to the same project')
  }

  // New and renamed names must be valid. An invalid name is accepted only
  // when it is unchanged AND already exists here (legacy secrets stay editable).
  if (edits.some((edit) => getSecretNameError(edit.name))) {
    const existingNames = new Set((await deriveSecrets(currentEnvId)).map((s) => s.name))
    for (const edit of edits) {
      const nameError = getSecretNameError(edit.name)
      if (!nameError) continue
      if (edit.name === edit.originalName && existingNames.has(edit.name)) continue
      throw new Error(nameError)
    }
  }

  const db = getDb()

  // Encrypt all values upfront so we can batch all inserts in one RPC
  const editsWithEncrypted = await Promise.all(
    edits.map(async (edit) => ({
      ...edit,
      enc: await encrypt(edit.value),
    })),
  )

  // Build all insert statements for the current environment
  const queries: BatchItem<'sqlite'>[] = []

  for (const edit of editsWithEncrypted) {
    const originalName = edit.originalName
    const isRename = !!originalName && edit.name !== originalName
    if (isRename) {
      queries.push(db.insert(schema.secretEvent).values({
        environmentId: currentEnvId, name: originalName,
        operation: 'delete', userId: session.userId,
      }))
    }
    queries.push(db.insert(schema.secretEvent).values({
      environmentId: currentEnvId, name: edit.name,
      operation: 'set', valueEncrypted: edit.enc!.encrypted, iv: edit.enc!.iv,
      userId: session.userId,
    }))
  }

  // Apply value changes to other environments
  const otherEnvIds = Array.from(new Set(environmentIds.slice(1))).filter((id) => id !== currentEnvId)
  for (const envId of otherEnvIds) {
    for (const edit of editsWithEncrypted) {
      queries.push(db.insert(schema.secretEvent).values({
        environmentId: envId, name: edit.name,
        operation: 'set', valueEncrypted: edit.enc!.encrypted, iv: edit.enc!.iv,
        userId: session.userId,
      }))
    }
  }

  const [firstQuery, ...restQueries] = queries
  if (firstQuery) {
    await db.batch([firstQuery, ...restQueries])
  }
}

const deleteEnvInput = z.object({ id: idSchema })

export async function deleteEnvAction(input: z.input<typeof deleteEnvInput>) {
  const { id } = parseInput(deleteEnvInput, input)
  const session = await requireSession()
  await requireEnvironmentAccess(session.userId, id)
  const db = getDb()
  await db.delete(schema.environment).where(orm.eq(schema.environment.id, id))
}

const createEnvInput = z.object({
  name: z.string().min(1, 'Name and slug are required'),
  slug: z.string().min(1, 'Name and slug are required'),
  projectId: idSchema,
})

export async function createEnvAction(input: z.input<typeof createEnvInput>) {
  const { name, slug, projectId } = parseInput(createEnvInput, input)
  const session = await requireSession()
  await requireProjectAccess(session.userId, projectId)
  const db = getDb()
  await db.insert(schema.environment).values({ projectId, name, slug })
  return { name }
}

const renameEnvInput = z.object({ id: idSchema, name: z.string().optional(), slug: z.string().optional() })

export async function renameEnvAction(input: z.input<typeof renameEnvInput>) {
  const { id, name, slug } = parseInput(renameEnvInput, input)
  if (!name && !slug) throw new Error('At least one of name or slug is required')
  const session = await requireSession()
  await requireEnvironmentAccess(session.userId, id)
  const db = getDb()
  const updates: Partial<{ name: string; slug: string; updatedAt: number }> = { updatedAt: Date.now() }
  if (name) updates.name = name
  if (slug) updates.slug = slug
  await db.update(schema.environment).set(updates).where(orm.eq(schema.environment.id, id))
  return { id }
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const createInviteInput = z.object({
  orgId: z.string().min(1, 'No org selected'),
  projectIds: idListSchema.optional(),
})

export async function createInviteAction(input: z.input<typeof createInviteInput>) {
  const { orgId, projectIds } = parseInput(createInviteInput, input)
  const session = await requireSession()
  const { role } = await requireOrgMember(session.userId, orgId)
  if (role !== 'admin') throw new Error('Only admins can create invites')

  // Validate project IDs belong to this org if provided
  if (projectIds && projectIds.length > 0) {
    const db = getDb()
    const orgProjects = await db.query.project.findMany({
      where: { orgId },
      columns: { id: true },
    })
    const validIds = new Set(orgProjects.map((p) => p.id))
    for (const pid of projectIds) {
      if (!validIds.has(pid)) throw new Error(`Project ${pid} does not belong to this organization`)
    }
  }

  const db = getDb()
  const [invite] = await db.insert(schema.orgInvitation).values({
    orgId,
    createdBy: session.userId,
    projectIds: projectIds && projectIds.length > 0 ? JSON.stringify(projectIds) : null,
    expiresAt: Date.now() + INVITE_EXPIRY_MS,
  }).returning({ id: schema.orgInvitation.id })
  return { id: invite!.id }
}

const acceptInviteInput = z.object({ invitationId: z.string().min(1, 'Invitation ID is required') })

// Finding the invitation IS the authorization here, so the id must be a plain string.
export async function acceptInviteAction(input: z.input<typeof acceptInviteInput>) {
  const { invitationId } = parseInput(acceptInviteInput, input)
  const session = await requireSession()
  const db = getDb()
  // Look up the invite without deleting — it stays valid until it expires.
  // This avoids a race where the page re-renders after accept and shows
  // "Invalid Invitation" because the row was already deleted.
  const invite = await db.query.orgInvitation.findFirst({
    where: { id: invitationId },
  })
  if (!invite || invite.expiresAt < Date.now()) throw new Error('Invitation not found or expired')
  const existing = await db.query.orgMember.findFirst({
    where: { orgId: invite.orgId, userId: session.userId },
    columns: { id: true },
  })
  if (!existing) {
    // A scoped invite whose projects were all deleted is refused: joining
    // with access to nothing would only confuse the invitee.
    const invitedProjectIds: string[] = invite.projectIds ? JSON.parse(invite.projectIds) : []
    const projects = invitedProjectIds.length > 0
      ? await db.query.project.findMany({ where: { orgId: invite.orgId, id: { in: invitedProjectIds } }, columns: { id: true } })
      : []
    if (invitedProjectIds.length > 0 && projects.length === 0) {
      throw new Error('The projects in this invitation no longer exist. Ask for a new invitation.')
    }
    // Membership and scope in one batch, so a failure never leaves a
    // half-scoped member behind. onConflictDoNothing keeps a double-submitted
    // accept a no-op (unique index on org_id + user_id).
    const memberId = ulid()
    await db.batch([
      db.insert(schema.orgMember)
        .values({
          id: memberId, orgId: invite.orgId, userId: session.userId, role: invite.role,
          projectAccess: invitedProjectIds.length > 0 ? 'selected' : 'all',
        })
        .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] }),
      ...projects.map((p) => db.insert(schema.memberAccess).values({ orgMemberId: memberId, projectId: p.id })),
    ])
  }

  throw redirect(router.href('/dash/orgs/:orgId', { orgId: invite.orgId }))
}

const updateOrgMemberRoleInput = z.object({ memberId: idSchema, role: roleSchema })

export async function updateOrgMemberRoleAction(input: z.input<typeof updateOrgMemberRoleInput>) {
  const { memberId, role } = parseInput(updateOrgMemberRoleInput, input)
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { id: memberId },
    columns: { id: true, orgId: true, userId: true, role: true },
  })
  if (!member) throw new Error('Member not found')

  await requireAdminRole(session.userId, member.orgId)

  if (member.role === role) {
    return { id: member.id, role: member.role }
  }

  if (member.role === 'admin' && role !== 'admin') {
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db.update(schema.orgMember)
    .set({ role })
    .where(orm.eq(schema.orgMember.id, member.id))
    .limit(1)

  return { id: member.id, role }
}

const removeOrgMemberInput = z.object({ memberId: idSchema })

export async function removeOrgMemberAction(input: z.input<typeof removeOrgMemberInput>) {
  const { memberId } = parseInput(removeOrgMemberInput, input)
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { id: memberId },
    columns: { id: true, orgId: true, userId: true, role: true },
  })
  if (!member) throw new Error('Member not found')

  await requireAdminRole(session.userId, member.orgId)

  if (member.role === 'admin') {
    await ensureAnotherAdminExists(member.orgId, member.userId)
  }

  await db.delete(schema.orgMember).where(orm.eq(schema.orgMember.id, member.id)).limit(1)
  return { id: member.id }
}

// ── API Token actions ───────────────────────────────────────────────

const createTokenInput = z.object({
  name: z.string().min(1, 'Name is required'),
  projectId: z.string().min(1, 'Project is required'),
  environmentIds: idListSchema.optional(),
})

export async function createTokenAction(input: z.input<typeof createTokenInput>) {
  const { name, projectId, environmentIds } = parseInput(createTokenInput, input)
  const session = await requireSession()
  const uniqueEnvIds = Array.from(new Set(environmentIds ?? []))
  await requireTokenScopeAccess({ userId: session.userId, projectId, environmentIds: uniqueEnvIds })
  const db = getDb()

  const { key, hashedKey, prefix } = await generateApiToken()
  const tokenId = ulid()
  await db.batch([
    db.insert(schema.apiToken).values({
      id: tokenId,
      name,
      projectId,
      prefix,
      hashedKey,
      createdBy: session.userId,
    }),
    ...uniqueEnvIds.map((environmentId) =>
      db.insert(schema.apiTokenEnvironment).values({ tokenId, environmentId }),
    ),
  ] as [any, ...any[]])

  // Return the full key — this is the only time it's ever available
  return { id: tokenId, key }
}

const deleteTokenInput = z.object({ tokenId: z.string().min(1, 'Token ID is required') })

export async function deleteTokenAction(input: z.input<typeof deleteTokenInput>) {
  const { tokenId } = parseInput(deleteTokenInput, input)
  const session = await requireSession()
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { id: tokenId },
    columns: { projectId: true },
    with: { environments: { columns: { environmentId: true } } },
  })
  if (!token) throw new Error('Token not found')
  await requireTokenScopeAccess({
    userId: session.userId,
    projectId: token.projectId,
    environmentIds: token.environments.map((row) => row.environmentId),
  })
  await db.delete(schema.apiToken).where(orm.eq(schema.apiToken.id, tokenId))
}

const syncMissingSecretsInput = z.object({
  sourceEnvironmentId: z.string().min(1, 'Both environment IDs are required'),
  targetEnvironmentId: z.string().min(1, 'Both environment IDs are required'),
  names: z.array(z.string()),
})

export async function syncMissingSecretsAction(input: z.input<typeof syncMissingSecretsInput>) {
  const { sourceEnvironmentId, targetEnvironmentId, names } = parseInput(syncMissingSecretsInput, input)
  if (sourceEnvironmentId === targetEnvironmentId) throw new Error('Source and target environments must be different')
  if (!names.length) throw new Error('No secret names provided')
  const session = await requireSession()

  const [source, target] = await Promise.all([
    requireEnvironmentAccess(session.userId, sourceEnvironmentId),
    requireEnvironmentAccess(session.userId, targetEnvironmentId),
  ])
  if (source.projectId !== target.projectId) throw new Error('Environments must belong to the same project')

  // Re-derive both sides server-side so we never overwrite a key that was
  // added to the target after the client loaded (stale tab race condition).
  const [sourceSecrets, targetSecrets] = await Promise.all([
    deriveSecrets(sourceEnvironmentId),
    deriveSecrets(targetEnvironmentId),
  ])
  const targetNames = new Set(targetSecrets.map((s) => s.name))
  const stillMissing = new Set(names.filter((name) => !targetNames.has(name)))
  // Legacy names that fail validation are not copied to new environments.
  const toSync = sourceSecrets.filter((s) => stillMissing.has(s.name) && !getSecretNameError(s.name))

  if (toSync.length === 0) return { count: 0 }

  const db = getDb()
  const queries: BatchItem<'sqlite'>[] = toSync.map((s) =>
    db.insert(schema.secretEvent).values({
      environmentId: targetEnvironmentId,
      name: s.name,
      operation: 'set',
      valueEncrypted: s.valueEncrypted,
      iv: s.iv,
      userId: session.userId,
    }),
  )

  const [firstQuery, ...restQueries] = queries
  if (!firstQuery) return { count: 0 }
  await db.batch([firstQuery, ...restQueries])
  return { count: toSync.length }
}

const createOrgInput = z.object({
  name: z.string().min(1, 'Name is required'),
  enableAutoJoin: z.boolean().optional(),
})

export async function createOrgAction(input: z.input<typeof createOrgInput>) {
  const { name, enableAutoJoin } = parseInput(createOrgInput, input)
  const session = await requireSession()

  let autoJoinDomain: string | null = null
  if (enableAutoJoin) {
    if (!session.user.emailVerified) throw new Error('Email must be verified to enable auto-join')
    const domain = getEmailDomain(session.user.email)
    if (!domain || COMMON_EMAIL_DOMAINS.has(domain)) {
      throw new Error('Cannot enable auto-join for public email domains')
    }
    autoJoinDomain = domain
  }

  const db = getDb()
  const orgId = ulid()
  const [[org]] = await db.batch([
    db.insert(schema.org).values({ id: orgId, name, autoJoinDomain }).returning({ id: schema.org.id, name: schema.org.name }),
    db.insert(schema.orgMember).values({ orgId, userId: session.userId, role: 'admin' }),
  ] as const)
  throw redirect(router.href('/dash/orgs/:orgId', { orgId: org!.id }))
}

const updateAutoJoinDomainInput = z.object({
  orgId: z.string().min(1, 'Org ID is required'),
  enabled: z.boolean(),
})

export async function updateAutoJoinDomainAction(input: z.input<typeof updateAutoJoinDomainInput>) {
  const { orgId, enabled } = parseInput(updateAutoJoinDomainInput, input)
  const session = await requireSession()
  await requireAdminRole(session.userId, orgId)

  let autoJoinDomain: string | null = null
  if (enabled) {
    if (!session.user.emailVerified) throw new Error('Email must be verified to enable auto-join')
    const domain = getEmailDomain(session.user.email)
    if (!domain || COMMON_EMAIL_DOMAINS.has(domain)) {
      throw new Error('Cannot enable auto-join for public email domains')
    }
    autoJoinDomain = domain
  }

  const db = getDb()
  await db.update(schema.org)
    .set({ autoJoinDomain, updatedAt: Date.now() })
    .where(orm.eq(schema.org.id, orgId))
    .limit(1)

  return { autoJoinDomain }
}

// ── Member access (granular project permissions) ────────────────────
// Admin-only. Sets which projects a member can access and which secrets
// are restricted. Passing an empty projects array reverts to "all access".

// projectIds null = all projects; [] = no projects.
const updateMemberAccessInput = z.object({ memberId: idSchema, projectIds: idListSchema.nullable() })

export async function updateMemberAccessAction(input: z.input<typeof updateMemberAccessInput>) {
  const { memberId, projectIds } = parseInput(updateMemberAccessInput, input)
  const session = await requireSession()
  const db = getDb()
  const member = await db.query.orgMember.findFirst({
    where: { id: memberId },
    columns: { id: true, orgId: true, role: true },
  })
  if (!member) throw new Error('Member not found')
  await requireAdminRole(session.userId, member.orgId)

  // Cannot restrict admins
  if (member.role === 'admin') throw new Error('Admins always have full access')

  const selected = projectIds ?? []
  const orgProjects = await db.query.project.findMany({
    where: { orgId: member.orgId },
    columns: { id: true },
  })
  const orgProjectIdsSet = new Set(orgProjects.map((p) => p.id))
  for (const pid of selected) {
    if (!orgProjectIdsSet.has(pid)) {
      throw new Error(`Project ${pid} does not belong to this organization`)
    }
  }

  // Mode and rules in one batch, so a failure keeps the old access.
  await db.batch([
    db.update(schema.orgMember)
      .set({ projectAccess: projectIds === null ? 'all' : 'selected' })
      .where(orm.eq(schema.orgMember.id, member.id)),
    db.delete(schema.memberAccess).where(orm.eq(schema.memberAccess.orgMemberId, member.id)),
    ...selected.map((projectId) => db.insert(schema.memberAccess).values({ orgMemberId: member.id, projectId })),
  ])

  return { ok: true }
}

// ── Environment access role ─────────────────────────────────────────
// Admins can restrict an environment (e.g. production) so only admins
// can read/write secrets in it. Members get 403 on all secret operations.

const updateEnvironmentAccessRoleInput = z.object({ environmentId: idSchema, accessRole: roleSchema })

export async function updateEnvironmentAccessRoleAction(input: z.input<typeof updateEnvironmentAccessRoleInput>) {
  const { environmentId, accessRole } = parseInput(updateEnvironmentAccessRoleInput, input)
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Error('Environment not found')
  await requireAdminRole(session.userId, orgId)
  const db = getDb()
  await db.update(schema.environment)
    .set({ accessRole, updatedAt: Date.now() })
    .where(orm.eq(schema.environment.id, environmentId))
    .limit(1)
  return { ok: true, environmentId, accessRole }
}

const deleteOrgInput = z.object({ orgId: z.string().min(1, 'Org ID is required') })

export async function deleteOrgAction(input: z.input<typeof deleteOrgInput>) {
  const { orgId } = parseInput(deleteOrgInput, input)
  const session = await requireSession()
  await requireAdminRole(session.userId, orgId)
  const db = getDb()
  // Cascade deletes handle orgMembers, invitations, projects, environments,
  // secretEvents, and apiTokens automatically via foreign key constraints.
  await db.delete(schema.org).where(orm.eq(schema.org.id, orgId))
  // /dash re-resolves the user's remaining orgs (or shows the create-org flow)
  throw redirect(router.href('/dash'))
}
