// Shared server actions for the Sigillo app UI.
// Client components import these directly instead of receiving action props.
//
// Every action authenticates via getActionRequest() → getSession() and
// verifies org membership before mutating data. No action accepts a raw
// userId — it always comes from the session cookie.
//
// Actions throw on error (caught by ErrorBoundary in the UI) and return
// objects on success. Never return strings or scalar values.

'use server'

import * as orm from 'drizzle-orm'
import * as schema from 'db/src/app-schema.ts'
import { getActionRequest } from 'spiceflow'
import {
  getDb, getSession,
  requireOrgMember,
  getOrgIdForProject, getOrgIdForEnvironment,
  encrypt,
  generateApiToken,
} from './db.ts'

async function requireSession() {
  const request = getActionRequest()
  const session = await getSession(request.headers)
  if (!session) throw new Error('Unauthorized')
  return session
}

export async function createProjectAction({ name, orgId }: { name: string; orgId: string }) {
  if (!name) throw new Error('Name is required')
  if (!orgId) throw new Error('No org selected')
  const session = await requireSession()
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  const [proj] = await db.insert(schema.project).values({ name, orgId })
    .returning({ id: schema.project.id, name: schema.project.name })
  for (const e of schema.DEFAULT_ENVIRONMENTS) {
    await db.insert(schema.environment).values({ projectId: proj!.id, name: e.name, slug: e.slug })
  }
  return { id: proj!.id, name: proj!.name }
}

// All secret mutations append to the secretEvent log. Never update or delete events.

export async function createSecretAction({ name, value, environmentId }: {
  name: string
  value: string
  environmentId: string
}) {
  if (!name || !value) throw new Error('Key and value are required')
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Error('Environment not found')
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  const { encrypted, iv } = await encrypt(value)
  await db.insert(schema.secretEvent).values({
    environmentId, name, operation: 'set',
    valueEncrypted: encrypted, iv, userId: session.userId,
  })
  return { name }
}

export async function deleteSecretAction({ name, environmentId }: {
  name: string
  environmentId: string
}) {
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Error('Environment not found')
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  await db.insert(schema.secretEvent).values({
    environmentId, name, operation: 'delete', userId: session.userId,
  })
}

// Save edited secrets to the current environment and optionally apply
// the same changes to additional environments. Each edit appends a "set"
// event to the log. Renames are handled as delete old name + set new name.
export async function saveSecretsAction({ edits, environmentIds }: {
  edits: { name: string; originalName: string; value?: string }[]
  environmentIds: string[]
}) {
  if (edits.length === 0 || environmentIds.length === 0) return
  const session = await requireSession()
  const currentEnvId = environmentIds[0]!
  const orgId = await getOrgIdForEnvironment(currentEnvId)
  if (!orgId) throw new Error('Environment not found')
  await requireOrgMember(session.userId, orgId)

  const db = getDb()

  // Apply edits to current environment
  for (const edit of edits) {
    const isRename = edit.name !== edit.originalName
    // If renamed, delete old name
    if (isRename) {
      await db.insert(schema.secretEvent).values({
        environmentId: currentEnvId, name: edit.originalName,
        operation: 'delete', userId: session.userId,
      })
    }
    // Set new/updated value (or re-set with same value under new name)
    if (edit.value !== undefined) {
      const { encrypted, iv } = await encrypt(edit.value)
      await db.insert(schema.secretEvent).values({
        environmentId: currentEnvId, name: edit.name,
        operation: 'set', valueEncrypted: encrypted, iv, userId: session.userId,
      })
    }
  }

  // Apply value changes to other environments
  const otherEnvIds = environmentIds.slice(1)
  const valueEdits = edits.filter((e) => e.value !== undefined)
  for (const envId of otherEnvIds) {
    const targetOrgId = await getOrgIdForEnvironment(envId)
    if (targetOrgId !== orgId) continue
    for (const edit of valueEdits) {
      const { encrypted, iv } = await encrypt(edit.value!)
      await db.insert(schema.secretEvent).values({
        environmentId: envId, name: edit.name,
        operation: 'set', valueEncrypted: encrypted, iv, userId: session.userId,
      })
    }
  }
}

export async function deleteEnvAction({ id }: { id: string }) {
  const session = await requireSession()
  const orgId = await getOrgIdForEnvironment(id)
  if (!orgId) throw new Error('Environment not found')
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  await db.delete(schema.environment).where(orm.eq(schema.environment.id, id))
}

export async function createEnvAction({ name, slug, projectId }: {
  name: string
  slug: string
  projectId: string
}) {
  if (!name || !slug) throw new Error('Name and slug are required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  await db.insert(schema.environment).values({ projectId, name, slug })
  return { name }
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export async function createInviteAction({ orgId }: { orgId: string }) {
  if (!orgId) throw new Error('No org selected')
  const session = await requireSession()
  const { role } = await requireOrgMember(session.userId, orgId)
  if (role !== 'admin') throw new Error('Only admins can create invites')
  const db = getDb()
  const [invite] = await db.insert(schema.orgInvitation).values({
    orgId,
    createdBy: session.userId,
    expiresAt: Date.now() + INVITE_EXPIRY_MS,
  }).returning({ id: schema.orgInvitation.id })
  return { id: invite!.id }
}

export async function acceptInviteAction({ invitationId }: { invitationId: string }) {
  if (!invitationId) throw new Error('Invitation ID is required')
  const session = await requireSession()
  const db = getDb()
  // Atomically consume the invite: DELETE ... RETURNING ensures only one
  // caller can claim it even if two requests race.
  const [invite] = await db.delete(schema.orgInvitation)
    .where(orm.and(
      orm.eq(schema.orgInvitation.id, invitationId),
      orm.gte(schema.orgInvitation.expiresAt, Date.now()),
    ))
    .returning({
      orgId: schema.orgInvitation.orgId,
      role: schema.orgInvitation.role,
    })
  if (!invite) throw new Error('Invitation not found or expired')
  // Insert membership, onConflictDoNothing handles the already-member case
  // (unique index on org_id + user_id prevents duplicates).
  const inserted = await db.insert(schema.orgMember)
    .values({ orgId: invite.orgId, userId: session.userId, role: invite.role })
    .onConflictDoNothing({ target: [schema.orgMember.orgId, schema.orgMember.userId] })
    .returning({ id: schema.orgMember.id })
  return { orgId: invite.orgId, alreadyMember: inserted.length === 0 }
}

// ── API Token actions ───────────────────────────────────────────────

export async function createTokenAction({ name, projectId, environmentId }: {
  name: string
  projectId: string
  environmentId?: string | null
}) {
  if (!name) throw new Error('Name is required')
  if (!projectId) throw new Error('Project is required')
  const session = await requireSession()
  const orgId = await getOrgIdForProject(projectId)
  if (!orgId) throw new Error('Project not found')
  await requireOrgMember(session.userId, orgId)

  // If environmentId is provided, verify it belongs to this project
  if (environmentId) {
    const db = getDb()
    const env = await db.query.environment.findFirst({
      where: { id: environmentId, projectId },
      columns: { id: true },
    })
    if (!env) throw new Error('Environment not found in this project')
  }

  const { key, hashedKey, prefix } = await generateApiToken()
  const db = getDb()
  const [token] = await db.insert(schema.apiToken).values({
    name,
    projectId,
    environmentId: environmentId || null,
    prefix,
    hashedKey,
    createdBy: session.userId,
  }).returning({ id: schema.apiToken.id })

  // Return the full key — this is the only time it's ever available
  return { id: token!.id, key }
}

export async function deleteTokenAction({ tokenId }: { tokenId: string }) {
  if (!tokenId) throw new Error('Token ID is required')
  const session = await requireSession()
  const db = getDb()
  const token = await db.query.apiToken.findFirst({
    where: { id: tokenId },
    columns: { projectId: true },
  })
  if (!token) throw new Error('Token not found')
  const orgId = await getOrgIdForProject(token.projectId)
  if (!orgId) throw new Error('Project not found')
  await requireOrgMember(session.userId, orgId)
  await db.delete(schema.apiToken).where(orm.eq(schema.apiToken.id, tokenId))
}

export async function createOrgAction({ name }: { name: string }) {
  if (!name) throw new Error('Name is required')
  const session = await requireSession()
  const db = getDb()
  const [org] = await db.insert(schema.org).values({ name }).returning({ id: schema.org.id, name: schema.org.name })
  await db.insert(schema.orgMember).values({ orgId: org!.id, userId: session.userId, role: 'admin' })
  return { id: org!.id, name: org!.name }
}
