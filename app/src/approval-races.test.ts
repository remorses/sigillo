// Regression tests for races in approvals.ts. Real workerd and D1, no mocks.
// Each race is replayed in order: the stale read, the concurrent write, then
// the write that used to trust the stale read.

import { describe, test, expect } from 'vitest'
import * as orm from 'drizzle-orm'
import { ulid } from 'ulid'
import { schema } from 'db'
import { getDb, joinOrgByEmailDomain } from './db.js'
import { addToPendingRequest, appendToPendingRequest, setReadApproval } from './approvals.js'

async function createEnvironment() {
  const db = getDb()
  const userId = ulid()
  const sessionId = ulid()
  const orgId = ulid()
  const projectId = ulid()
  const environmentId = ulid()
  await db.batch([
    db.insert(schema.user).values({ id: userId, name: 'Ada', email: `races-${userId}@example.com` }),
    db.insert(schema.session).values({ id: sessionId, userId, token: ulid(), expiresAt: Date.now() + 60_000, kind: 'cli' }),
    db.insert(schema.org).values({ id: orgId, name: 'Races org' }),
    db.insert(schema.project).values({ id: projectId, orgId, name: 'website' }),
    db.insert(schema.environment).values({ id: environmentId, projectId, name: 'Prod', slug: 'prod' }),
  ] as const)
  return { userId, orgId, credential: { sessionId, apiTokenId: null }, environmentId }
}

async function itemNames(requestId: string) {
  const items = await getDb().query.approvalItem.findMany({ where: { requestId } })
  return items.map((item) => item.secretName).sort()
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

describe('approval races', () => {
  test('a stale domain match cannot add a member after trusted setup clears auto-join', async () => {
    const { userId, orgId } = await createEnvironment()
    const db = getDb()
    const domain = 'example.com'
    await db.update(schema.org).set({ autoJoinDomain: domain }).where(orm.eq(schema.org.id, orgId)).limit(1)
    // The authenticated loader has already found this matching organization.
    const matched = await db.query.org.findFirst({ where: { id: orgId, autoJoinDomain: domain } })
    expect(matched?.id).toBe(orgId)
    // Trusted setup clears the domain before that loader's membership insert.
    await db.update(schema.org)
      .set({ trustInitializedAt: Date.now(), autoJoinDomain: null })
      .where(orm.eq(schema.org.id, orgId)).limit(1)
    await joinOrgByEmailDomain({ orgId: matched!.id, userId, domain })
    expect(await db.query.orgMember.findFirst({ where: { orgId, userId } })).toBeUndefined()

    // A domain explicitly re-enabled by the admin can admit members, idempotently.
    await db.update(schema.org).set({ autoJoinDomain: domain }).where(orm.eq(schema.org.id, orgId)).limit(1)
    await joinOrgByEmailDomain({ orgId, userId, domain })
    await joinOrgByEmailDomain({ orgId, userId, domain })
    expect(await db.query.orgMember.findMany({ where: { orgId, userId } })).toHaveLength(1)
  })

  test('a blocked read never adds items to a request approved after it looked the request up', async () => {
    const { userId, credential, environmentId } = await createEnvironment()
    const db = getDb()
    const item = (secretName: string) => ({ environmentId, secretName })

    const { id } = await addToPendingRequest({ credential, requesterId: userId, items: [item('A')] })
    expect(await appendToPendingRequest({ id, items: [item('B'), item('A')], label: 'Deploy', now: Date.now() })).toBe(true)
    expect(await itemNames(id)).toEqual(['A', 'B'])

    // addToPendingRequest read the request as pending, then the human approved it.
    const now = Date.now()
    await db.update(schema.approvalRequest)
      .set({ status: 'approved', approvedBy: userId, approvedAt: now, lastUsedAt: now })
      .where(orm.eq(schema.approvalRequest.id, id))
    expect(await appendToPendingRequest({ id, items: [item('C')], label: 'Widen', now })).toBe(false)
    const approved = await db.query.approvalRequest.findFirst({ where: { id } })
    expect({ label: approved!.label, items: await itemNames(id) }).toEqual({ label: 'Deploy', items: ['A', 'B'] })

    // The read that lost the race goes to a new pending request instead.
    const next = await addToPendingRequest({ credential, requesterId: userId, items: [item('C')] })
    expect(next.id).not.toBe(id)
    expect(await itemNames(next.id)).toEqual(['C'])

    // An expired pending request is not extended or edited either.
    await db.update(schema.approvalRequest).set({ expiresAt: now - 1 }).where(orm.eq(schema.approvalRequest.id, next.id))
    expect(await appendToPendingRequest({ id: next.id, items: [item('D')], now })).toBe(false)
    expect(await itemNames(next.id)).toEqual(['C'])
  })

  test('a protection change decided on a stale value is refused instead of overwriting a concurrent one', async () => {
    const { environmentId } = await createEnvironment()
    const readApproval = async () => (await getDb().query.environment.findFirst({ where: { id: environmentId } }))!.readApproval

    // Admin A reads 'off' and raises to 'selected' (no passkey needed for a raise).
    // Admin B raises to 'all' first.
    await setReadApproval({ environmentId, from: 'off', to: 'all' })
    expect(await setReadApproval({ environmentId, from: 'off', to: 'selected' }).catch(message)).toMatchInlineSnapshot(`"Approval settings changed meanwhile. Reload and try again."`)
    expect(await readApproval()).toBe('all')
  })
})
