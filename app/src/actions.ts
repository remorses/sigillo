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
  getOrgIdForProject, getOrgIdForEnvironment, getOrgIdForSecret,
  encrypt,
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
  await db.insert(schema.secret).values({
    environmentId, name, valueEncrypted: encrypted, iv, createdBy: session.userId,
  })
  return { name }
}

export async function deleteSecretAction({ id }: { id: string }) {
  const session = await requireSession()
  const orgId = await getOrgIdForSecret(id)
  if (!orgId) throw new Error('Secret not found')
  await requireOrgMember(session.userId, orgId)
  const db = getDb()
  await db.delete(schema.secret).where(orm.eq(schema.secret.id, id))
}

// Save edited secrets to the current environment and optionally apply
// the same changes to additional environments (by name-based upsert).
// environmentIds[0] is the current env (edits applied by secret ID),
// the rest are cross-env targets (edits applied by secret name).
export async function saveSecretsAction({ edits, environmentIds }: {
  edits: { id: string; name: string; value?: string }[]
  environmentIds: string[]
}) {
  if (edits.length === 0 || environmentIds.length === 0) return
  const session = await requireSession()
  const orgId = await getOrgIdForSecret(edits[0]!.id)
  if (!orgId) throw new Error('Secret not found')
  await requireOrgMember(session.userId, orgId)

  const db = getDb()
  const otherEnvIds = environmentIds.slice(1)

  // Apply edits to current environment by secret ID (supports rename + value change)
  for (const edit of edits) {
    if (edit.name !== undefined) {
      await db.update(schema.secret).set({ name: edit.name, updatedAt: Date.now() })
        .where(orm.eq(schema.secret.id, edit.id))
    }
    if (edit.value !== undefined) {
      const { encrypted, iv } = await encrypt(edit.value)
      await db.update(schema.secret).set({ valueEncrypted: encrypted, iv, updatedAt: Date.now() })
        .where(orm.eq(schema.secret.id, edit.id))
    }
  }

  // Apply value changes to other environments by name-based upsert
  const valueEdits = edits.filter((e) => e.value !== undefined)
  for (const envId of otherEnvIds) {
    const targetOrgId = await getOrgIdForEnvironment(envId)
    if (targetOrgId !== orgId) continue
    for (const edit of valueEdits) {
      const existing = await db.query.secret.findFirst({
        where: { environmentId: envId, name: edit.name },
      })
      const { encrypted, iv } = await encrypt(edit.value!)
      if (existing) {
        await db.update(schema.secret).set({ valueEncrypted: encrypted, iv, updatedAt: Date.now() })
          .where(orm.eq(schema.secret.id, existing.id))
      } else {
        await db.insert(schema.secret).values({
          environmentId: envId, name: edit.name,
          valueEncrypted: encrypted, iv, createdBy: session.userId,
        })
      }
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
  const invite = await db.query.orgInvitation.findFirst({ where: { id: invitationId } })
  if (!invite) throw new Error('Invitation not found')
  if (invite.expiresAt < Date.now()) throw new Error('Invitation has expired')
  // Check if already a member
  const existing = await db.query.orgMember.findFirst({
    where: { orgId: invite.orgId, userId: session.userId },
  })
  if (existing) return { orgId: invite.orgId, alreadyMember: true }
  // Add as member and delete the invitation
  await db.insert(schema.orgMember).values({
    orgId: invite.orgId,
    userId: session.userId,
    role: invite.role,
  })
  await db.delete(schema.orgInvitation).where(orm.eq(schema.orgInvitation.id, invitationId))
  return { orgId: invite.orgId, alreadyMember: false }
}

export async function createOrgAction({ name }: { name: string }) {
  if (!name) throw new Error('Name is required')
  const session = await requireSession()
  const db = getDb()
  const [org] = await db.insert(schema.org).values({ name }).returning({ id: schema.org.id, name: schema.org.name })
  await db.insert(schema.orgMember).values({ orgId: org!.id, userId: session.userId, role: 'admin' })
  return { id: org!.id, name: org!.name }
}
