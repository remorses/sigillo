// Shared server actions for the Sigillo app UI.
// Client components import these directly instead of receiving action props.

'use server'

import { env } from 'cloudflare:workers'
import type { SecretsStore } from './secrets-store.ts'

function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}

function getFormString(formData: FormData, key: string) {
  const value = formData.get(key)
  return typeof value === 'string' ? value : ''
}

export async function createProjectAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const orgId = getFormString(formData, 'orgId')
  if (!name) return 'Name is required'
  if (!orgId) return 'No org selected'
  const stub = getSecretsStoreStub()
  const project = await stub.createProject({ name, orgId })
  return `Created:${project.id}`
}

export async function createSecretAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const value = getFormString(formData, 'value')
  const environmentId = getFormString(formData, 'environmentId')
  if (!name || !value) return 'Key and value are required'
  const stub = getSecretsStoreStub()
  await stub.createSecret({ environmentId, name, value, createdBy: 'system' })
  return `Created ${name}`
}

export async function deleteSecretAction(id: string) {
  const stub = getSecretsStoreStub()
  await stub.deleteSecret({ id })
}

export async function saveSecretsAction(edits: { id: string; name?: string; value?: string }[]) {
  const stub = getSecretsStoreStub()
  for (const edit of edits) {
    await stub.updateSecret({ id: edit.id, name: edit.name, value: edit.value })
  }
}

export async function deleteEnvAction(id: string) {
  const stub = getSecretsStoreStub()
  await stub.deleteEnvironment({ id })
}

export async function createEnvAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  const slug = getFormString(formData, 'slug')
  const projectId = getFormString(formData, 'projectId')
  if (!name || !slug) return 'Name and slug are required'
  const stub = getSecretsStoreStub()
  await stub.createEnvironment({ projectId, name, slug })
  return `Created ${name}`
}

export async function createOrgAction(_prev: string, formData: FormData) {
  const name = getFormString(formData, 'name')
  if (!name) return 'Name is required'
  const stub = getSecretsStoreStub()
  const org = await stub.createOrg({ name, userId: 'system' })
  return `Created:${org.id}`
}
