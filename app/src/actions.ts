// Shared server actions for the Sigillo app UI.
// Client components import these directly instead of receiving action props.
//
// Every action authenticates via getActionRequest() → getSession() and
// verifies org membership before mutating data. No action accepts a raw
// userId — it always comes from the session cookie.

'use server'

import { env } from 'cloudflare:workers'
import { getActionRequest } from 'spiceflow'
import type { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === 'string' ? value : ''
}

async function requireSession(stub: DurableObjectStub<SecretsStore>) {
  const request = getActionRequest()
  const session = await stub.getSession(request)
  if (!session) throw new Error('Unauthorized')
  return session
}

export async function createProjectAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const orgId = getFormString(formData, 'orgId')
  if (!name) return 'Name is required'
  if (!orgId) return 'No org selected'
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  await stub.requireOrgMember({ userId: session.userId, orgId })
  const project = await stub.createProject({ name, orgId })
  return `Created:${project.id}`
}

export async function createSecretAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const value = getFormString(formData, 'value')
  const environmentId = getFormString(formData, 'environmentId')
  if (!name || !value) return 'Key and value are required'
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  const orgId = await stub.getOrgIdForEnvironment({ environmentId })
  if (!orgId) return 'Environment not found'
  await stub.requireOrgMember({ userId: session.userId, orgId })
  await stub.createSecret({ environmentId, name, value, createdBy: session.userId })
  return `Created ${name}`
}

export async function deleteSecretAction(id: string) {
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  const orgId = await stub.getOrgIdForSecret({ secretId: id })
  if (!orgId) throw new Error('Secret not found')
  await stub.requireOrgMember({ userId: session.userId, orgId })
  await stub.deleteSecret({ id })
}

export async function saveSecretsAction(edits: { id: string; name?: string; value?: string }[]) {
  if (edits.length === 0) return
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  // Verify org membership using the first secret — all secrets in a batch
  // belong to the same environment (same org)
  const orgId = await stub.getOrgIdForSecret({ secretId: edits[0]!.id })
  if (!orgId) throw new Error('Secret not found')
  await stub.requireOrgMember({ userId: session.userId, orgId })
  for (const edit of edits) {
    await stub.updateSecret({ id: edit.id, name: edit.name, value: edit.value })
  }
}

export async function deleteEnvAction(id: string) {
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  const orgId = await stub.getOrgIdForEnvironment({ environmentId: id })
  if (!orgId) throw new Error('Environment not found')
  await stub.requireOrgMember({ userId: session.userId, orgId })
  await stub.deleteEnvironment({ id })
}

export async function createEnvAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const slug = getFormString(formData, 'slug')
  const projectId = getFormString(formData, 'projectId')
  if (!name || !slug) return 'Name and slug are required'
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  const orgId = await stub.getOrgIdForProject({ projectId })
  if (!orgId) return 'Project not found'
  await stub.requireOrgMember({ userId: session.userId, orgId })
  await stub.createEnvironment({ projectId, name, slug })
  return `Created ${name}`
}

export async function createOrgAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  if (!name) return 'Name is required'
  const stub = getSecretsStoreStub()
  const session = await requireSession(stub)
  const org = await stub.createOrg({ name, userId: session.userId })
  return `Created:${org.id}`
}
