// Approval requests and grants for reading protected secrets.
//
// An environment decides what is protected (environment.readApproval):
//   off       nothing
//   selected  the names in secret_approval
//   all       every secret, also ones added later
//
// A credential (one session or one API token) can read a protected secret only
// while it holds a grant: an approval_request row with status 'approved' that
// a human confirmed with a passkey. Grants never transfer between credentials.
//
//   blocked read ──▶ pending request (one per credential, agents edit it)
//                        │ human approves with a passkey
//                        ▼
//                    grant ──▶ ends 1 hour after its last use, or on revoke
//
// The website is not trusted more than the CLI: the CLI token is a normal
// session and agents can drive a logged-in browser. So dashboard loaders use
// the same check, with a short unlock grant bound to the browser session.

import * as orm from 'drizzle-orm'
import { ulid } from 'ulid'
import { schema } from 'db'
import {
  getDb,
  getEnvironmentAccessError,
  getMemberAccess,
  type SecretsAuth,
  type Session,
} from './db.ts'

// A grant ends when no protected read used it for this long.
const GRANT_IDLE_MS = 60 * 60 * 1000
// A pending request nobody approved ends this long after its last edit.
const PENDING_TTL_MS = 60 * 60 * 1000
// Website unlock: long enough to reveal and copy, too short to be reused.
const UNLOCK_TTL_MS = 60 * 1000
// lastUsedAt is written at most this often, so reads do not cost a write each.
const TOUCH_INTERVAL_MS = 60 * 1000

export const APPROVAL_LABEL_MAX_LENGTH = 200
// '' as a secret name means every secret in the environment.
const ALL_SECRETS = ''

type ReadApproval = (typeof schema.environment.$inferSelect)['readApproval']
type ProtectedEnvironment = { id: string; readApproval: ReadApproval }

export type Credential = Pick<SecretsAuth, 'sessionId' | 'apiTokenId'>

function credentialFilter(credential: Credential) {
  return credential.sessionId ? { sessionId: credential.sessionId } : { apiTokenId: credential.apiTokenId! }
}

type GrantRow = Pick<
  typeof schema.approvalRequest.$inferSelect,
  'status' | 'expiry' | 'lastUsedAt' | 'approvedAt' | 'grantExpiresAt'
>

export function isGrantActive(grant: GrantRow, now: number): boolean {
  if (grant.status !== 'approved') return false
  if (grant.grantExpiresAt != null && grant.grantExpiresAt <= now) return false
  if (grant.expiry === 'never') return true
  return (grant.lastUsedAt ?? grant.approvedAt ?? 0) + GRANT_IDLE_MS > now
}

type RequestState = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'

export function getRequestState(request: GrantRow & { expiresAt: number }, now: number): RequestState {
  if (request.status === 'pending') return request.expiresAt > now ? 'pending' : 'expired'
  if (request.status === 'approved') return isGrantActive(request, now) ? 'approved' : 'expired'
  return request.status
}

// Names among `names` that are protected in this environment.
async function getProtectedNames(environment: ProtectedEnvironment, names: string[]): Promise<string[]> {
  if (environment.readApproval === 'off' || names.length === 0) return []
  if (environment.readApproval === 'all') return names
  const rows = await getDb().query.secretApproval.findMany({ where: { environmentId: environment.id } })
  const protectedNames = new Set(rows.map((row) => row.name))
  return names.filter((name) => protectedNames.has(name))
}

// Names among `names` this credential may not read right now: protected and
// not covered by an active grant. Marks the grants it relied on as used.
// Never creates a request, so loaders can call it.
export async function getLockedNames({ credential, environment, names }: {
  credential: Credential
  environment: ProtectedEnvironment
  names: string[]
}): Promise<string[]> {
  const required = await getProtectedNames(environment, names)
  if (required.length === 0) return []

  const db = getDb()
  const now = Date.now()
  const grants = await db.query.approvalRequest.findMany({
    where: {
      ...credentialFilter(credential),
      status: 'approved',
      OR: [{ expiry: 'never' }, { lastUsedAt: { gt: now - GRANT_IDLE_MS } }],
    },
    with: { items: { where: { environmentId: environment.id } } },
  })

  const covered = new Set<string>()
  const used: typeof grants = []
  for (const grant of grants) {
    if (!isGrantActive(grant, now) || grant.items.length === 0) continue
    used.push(grant)
    for (const item of grant.items) covered.add(item.secretName)
  }
  const locked = covered.has(ALL_SECRETS) ? [] : required.filter((name) => !covered.has(name))

  const stale = used.filter((grant) => (grant.lastUsedAt ?? 0) + TOUCH_INTERVAL_MS < now).map((grant) => grant.id)
  if (stale.length > 0 && locked.length < required.length) {
    await db.update(schema.approvalRequest)
      .set({ lastUsedAt: now })
      .where(orm.inArray(schema.approvalRequest.id, stale))
  }
  return locked
}

type RequestItem = { environmentId: string; secretName: string }

// Adds items to the pending request of this credential, creating it when
// there is none. Agents batch by editing this one request, so the user gets
// one URL and one passkey prompt.
export async function addToPendingRequest({ credential, requesterId, items, label }: {
  credential: Credential
  requesterId: string
  items: RequestItem[]
  label?: string
}): Promise<{ id: string; expiresAt: number }> {
  const db = getDb()
  const now = Date.now()
  const expiresAt = now + PENDING_TTL_MS
  const pending = await db.query.approvalRequest.findFirst({
    where: { ...credentialFilter(credential), status: 'pending', expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
  })
  // The request can be approved after the read above: then start a new one.
  if (pending && await appendToPendingRequest({ id: pending.id, items, label, now })) {
    return { id: pending.id, expiresAt }
  }
  const id = ulid()
  await db.batch([
    db.insert(schema.approvalRequest).values({
      id, expiresAt, label: label ?? '', userId: requesterId,
      sessionId: credential.sessionId, apiTokenId: credential.apiTokenId,
    }),
    ...items.map((item) => db.insert(schema.approvalItem).values({ requestId: id, ...item }).onConflictDoNothing()),
  ])
  return { id, expiresAt }
}

// Adds items to request `id` and extends it, only while it is still pending.
// Every statement re-checks that, so an item never lands on a request a human
// approved, denied or let expire in the meantime. Returns false then.
export async function appendToPendingRequest({ id, items, label, now }: {
  id: string
  items: RequestItem[]
  label?: string
  now: number
}): Promise<boolean> {
  const db = getDb()
  const expiresAt = now + PENDING_TTL_MS
  const isPending = orm.and(
    orm.eq(schema.approvalRequest.id, id),
    orm.eq(schema.approvalRequest.status, 'pending'),
    orm.gt(schema.approvalRequest.expiresAt, now),
  )
  const [updated] = await db.batch([
    db.update(schema.approvalRequest)
      .set(label === undefined ? { expiresAt } : { expiresAt, label })
      .where(isPending)
      .returning({ id: schema.approvalRequest.id }),
    ...items.map((item) => db.insert(schema.approvalItem)
      .select((qb) => qb
        .select({
          id: orm.sql<string>`${ulid()}`.as('id'),
          requestId: orm.sql<string>`${id}`.as('request_id'),
          environmentId: orm.sql<string>`${item.environmentId}`.as('environment_id'),
          secretName: orm.sql<string>`${item.secretName}`.as('secret_name'),
        })
        .from(schema.approvalRequest)
        .where(isPending))
      .onConflictDoNothing()),
  ])
  return updated.length > 0
}

// Changes what is protected only if it is still `from`, the value the caller
// checked its passkey rule against. Otherwise a raise decided on a stale 'off'
// could overwrite a concurrent 'all' with 'selected', lowering it for free.
export async function setReadApproval({ environmentId, from, to }: {
  environmentId: string
  from: ReadApproval
  to: ReadApproval
}): Promise<void> {
  const [updated] = await getDb().update(schema.environment)
    .set({ readApproval: to, updatedAt: Date.now() })
    .where(orm.and(orm.eq(schema.environment.id, environmentId), orm.eq(schema.environment.readApproval, from)))
    .returning({ id: schema.environment.id })
  if (!updated) throw new Error('Approval settings changed meanwhile. Reload and try again.')
}

export function getApprovalUrl(origin: string, requestId: string) {
  return `${origin}/approve/${encodeURIComponent(requestId)}`
}

// The gate for REST reads. Returns null when the read may go on. Otherwise
// the locked names were added to the credential's pending request and the
// caller answers 403 with its URL.
//
// scope 'environment' = the caller reads every secret (download, run). In an
// 'all' environment that asks for the whole environment, so secrets added
// later are covered too.
export async function requestReadApproval({ auth, environment, names, scope, origin, label }: {
  auth: SecretsAuth
  environment: ProtectedEnvironment
  names: string[]
  scope: 'environment' | 'names'
  origin: string
  label?: string
}): Promise<{ id: string; url: string; expiresAt: number } | null> {
  const locked = await getLockedNames({ credential: auth, environment, names })
  if (locked.length === 0) return null
  const itemNames = environment.readApproval === 'all' && scope === 'environment' ? [ALL_SECRETS] : locked
  const request = await addToPendingRequest({
    credential: auth,
    requesterId: auth.requesterId,
    items: itemNames.map((secretName) => ({ environmentId: environment.id, secretName })),
    label,
  })
  return { ...request, url: getApprovalUrl(origin, request.id) }
}

export function approvalRequiredBody(approval: { id: string; url: string }) {
  return {
    // Old CLIs print only `error`, so it carries the URL too.
    error: `approval required. Open ${approval.url} and approve with your passkey, then run the command again`,
    code: 'approval_required' as const,
    approvalId: approval.id,
    approvalUrl: approval.url,
  }
}

// ── Reading a request for a human ───────────────────────────────────

export async function getRequestDetails(requestId: string) {
  return getDb().query.approvalRequest.findFirst({
    where: { id: requestId },
    with: {
      user: true,
      approver: true,
      session: true,
      apiToken: true,
      items: { with: { environment: { with: { project: true } } } },
    },
  })
}

export type RequestDetails = NonNullable<Awaited<ReturnType<typeof getRequestDetails>>>

export function describeRequester(request: Pick<RequestDetails, 'user' | 'session' | 'apiToken' | 'sessionId' | 'apiTokenId'>) {
  if (request.apiToken) return { kind: 'token' as const, name: request.apiToken.name }
  const name = request.user?.name ?? 'Someone'
  if (request.session?.kind === 'cli') return { kind: 'cli' as const, name }
  if (request.session) return { kind: 'browser' as const, name }
  return { kind: 'gone' as const, name }
}

// Items the viewer may approve: the normal environment access rule (org
// member, project access, admin for admin-only environments).
export async function getApprovableItemIds(request: RequestDetails, userId: string): Promise<Set<string>> {
  const orgIds = [...new Set(request.items.map((item) => item.environment?.project?.orgId).filter((id): id is string => !!id))]
  const accessByOrg = new Map(await Promise.all(
    orgIds.map(async (orgId) => [orgId, await getMemberAccess({ userId, orgId })] as const),
  ))
  const allowed = new Set<string>()
  for (const item of request.items) {
    const environment = item.environment
    const orgId = environment?.project?.orgId
    if (!environment || !orgId) continue
    if (!getEnvironmentAccessError(accessByOrg.get(orgId) ?? null, environment)) allowed.add(item.id)
  }
  return allowed
}

// A session request belongs to its user: only they approve their own agent.
// A token request can be handled by any member who can access what it asks.
export function getRequestRole(request: RequestDetails, session: Session, approvable: Set<string>) {
  if (request.apiTokenId) return approvable.size > 0 ? 'approver' as const : null
  return request.userId === session.userId ? 'approver' as const : null
}

// ── Decisions ───────────────────────────────────────────────────────

// `confirm` verifies the passkey. It runs after every other check, so the
// user is not asked to touch the sensor for a request that will be refused.
export async function approveRequest({ request, session, itemIds, seenItemIds, keep, confirm }: {
  request: RequestDetails
  session: Session
  itemIds: string[]
  seenItemIds: string[]
  keep: boolean
  confirm: () => Promise<void>
}) {
  const now = Date.now()
  if (getRequestState(request, now) !== 'pending') throw new Error('This request is no longer pending.')
  // The agent can edit the request while the page is open. Never approve
  // items the human did not see.
  const current = request.items.map((item) => item.id).sort()
  if (current.join() !== [...seenItemIds].sort().join()) {
    throw new Error('This request changed. Review it again.')
  }
  const selected = new Set(itemIds)
  if (selected.size === 0 || itemIds.some((id) => !current.includes(id))) throw new Error('Select at least one item to approve.')
  const approvable = await getApprovableItemIds(request, session.userId)
  if (!getRequestRole(request, session, approvable)) throw new Error('You cannot approve this request.')
  if (itemIds.some((id) => !approvable.has(id))) throw new Error('You do not have access to every selected environment.')
  if (keep && !request.apiTokenId) throw new Error('Only API tokens can be approved until revoked.')
  await confirm()

  const db = getDb()
  await db.batch([
    db.update(schema.approvalRequest)
      .set({ status: 'approved', approvedBy: session.userId, approvedAt: now, lastUsedAt: now, expiry: keep ? 'never' : 'idle' })
      .where(orm.and(orm.eq(schema.approvalRequest.id, request.id), orm.eq(schema.approvalRequest.status, 'pending')))
      .limit(1),
    // Everything not approved goes: unchecked items, and items a blocked read
    // added while the human was looking at the passkey prompt.
    db.delete(schema.approvalItem).where(orm.and(
      orm.eq(schema.approvalItem.requestId, request.id),
      orm.notInArray(schema.approvalItem.id, itemIds),
    )),
  ] as const)
}

export async function closeRequest({ request, session, status }: {
  request: RequestDetails
  session: Session
  status: 'denied' | 'revoked'
}) {
  const approvable = await getApprovableItemIds(request, session.userId)
  const allowed = getRequestRole(request, session, approvable) || request.approvedBy === session.userId
  if (!allowed) throw new Error('You cannot change this request.')
  const from = status === 'denied' ? 'pending' : 'approved'
  await getDb().update(schema.approvalRequest)
    .set({ status })
    .where(orm.and(orm.eq(schema.approvalRequest.id, request.id), orm.eq(schema.approvalRequest.status, from)))
    .limit(1)
}

// Website unlock: a 1 minute grant for this browser session and environment.
// The caller has verified the passkey and the environment access.
export async function unlockEnvironment({ session, environmentId }: { session: Session; environmentId: string }) {
  const db = getDb()
  const now = Date.now()
  const id = ulid()
  await db.batch([
    db.insert(schema.approvalRequest).values({
      id, userId: session.userId, sessionId: session.sessionId, status: 'approved',
      expiresAt: now, approvedBy: session.userId, approvedAt: now, lastUsedAt: now,
      grantExpiresAt: now + UNLOCK_TTL_MS,
    }),
    db.insert(schema.approvalItem).values({ requestId: id, environmentId, secretName: ALL_SECRETS }),
  ] as const)
}

// Requests shown in the Approvals tab of a project: pending ones and live
// grants. Own session requests plus API token requests. Website unlocks
// (the only rows with grantExpiresAt) are not listed.
export async function listProjectRequests({ projectId, userId }: { projectId: string; userId: string }) {
  const now = Date.now()
  const requests = await getDb().query.approvalRequest.findMany({
    where: {
      items: { environment: { projectId } },
      grantExpiresAt: { isNull: true },
      status: { in: ['pending', 'approved'] },
      OR: [{ userId }, { apiTokenId: { isNotNull: true } }],
    },
    with: {
      user: true,
      approver: true,
      session: true,
      apiToken: true,
      items: { with: { environment: { with: { project: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    limit: 50,
  })
  return requests.filter((request) => {
    const state = getRequestState(request, now)
    return (state === 'pending' || state === 'approved') && (request.sessionId || request.apiTokenId)
  })
}

export function describeItems(items: RequestDetails['items']) {
  return items
    .filter((item) => item.environment)
    .map((item) => ({
      id: item.id,
      environmentId: item.environmentId,
      environmentName: item.environment!.name,
      projectId: item.environment!.projectId,
      projectName: item.environment!.project?.name ?? '',
      secretName: item.secretName,
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName) || a.environmentName.localeCompare(b.environmentName) || a.secretName.localeCompare(b.secretName))
}
