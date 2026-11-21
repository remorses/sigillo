'use server'
// Directive stays on line 1: spiceflow strips it in vitest only when it is the first statement.

// Server actions for passkeys and approvals. Same rules as actions.ts: every
// action reads the session itself and parses its input with zod first.
//
// Actions that LOWER protection or hand out access take a passkey assertion
// and check it with requirePasskey() for their exact intent. Actions that only
// raise protection or remove access (add a protected secret, deny, revoke) do
// not: an agent gains nothing by calling them.

import * as orm from 'drizzle-orm'
import { z } from 'zod'
import { schema } from 'db'
import { getActionRequest } from 'spiceflow'
import {
  decrypt,
  deriveSecrets,
  getDb,
  getOrgIdForEnvironment,
  getSession,
  getUserEnvironmentAccess,
  requireOrgMember,
} from './db.ts'
import {
  finishPasskeyRegistration,
  listPasskeys,
  passkeyIntentSchema,
  removePasskey,
  requirePasskey,
  startPasskeyAssertion,
  startPasskeyRegistration,
  webAuthnResponseSchema,
} from './passkey.ts'
import {
  approveRequest,
  closeRequest,
  getLockedNames,
  getRequestDetails,
  unlockEnvironment,
} from './approvals.ts'

const idSchema = z.string().min(1)
const readApprovalSchema = z.enum(['off', 'selected', 'all'])
const PROTECTION_LEVEL = { off: 0, selected: 1, all: 2 } as const

function parseInput<T extends z.ZodType>(schema: T, input: z.input<T>): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'Invalid input')
  return result.data
}

async function requireSession() {
  const request = getActionRequest()
  const session = await getSession(request)
  if (!session) throw new Error('Unauthorized')
  return { request, session }
}

async function requireEnvironmentAdmin(userId: string, environmentId: string) {
  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Error('Environment not found')
  const { role } = await requireOrgMember(userId, orgId)
  if (role !== 'admin') throw new Error('Only admins can change approval settings')
}

// ── Passkeys ────────────────────────────────────────────────────────

const startRegistrationInput = z.object({ assertion: webAuthnResponseSchema.optional() })

export async function startPasskeyRegistrationAction(input: z.input<typeof startRegistrationInput>) {
  const { assertion } = parseInput(startRegistrationInput, input)
  const { request, session } = await requireSession()
  return { options: await startPasskeyRegistration({ request, session, assertion }) }
}

const finishRegistrationInput = z.object({ response: webAuthnResponseSchema, name: z.string() })

export async function finishPasskeyRegistrationAction(input: z.input<typeof finishRegistrationInput>) {
  const { response, name } = parseInput(finishRegistrationInput, input)
  const { request, session } = await requireSession()
  return finishPasskeyRegistration({ request, session, response, name })
}

const startAssertionInput = z.object({ intent: passkeyIntentSchema })

export async function startPasskeyAssertionAction(input: z.input<typeof startAssertionInput>) {
  const { intent } = parseInput(startAssertionInput, input)
  const { request, session } = await requireSession()
  return { options: await startPasskeyAssertion({ request, session, intent }) }
}

const removePasskeyInput = z.object({ passkeyId: idSchema, assertion: webAuthnResponseSchema })

export async function removePasskeyAction(input: z.input<typeof removePasskeyInput>) {
  const { passkeyId, assertion } = parseInput(removePasskeyInput, input)
  const { request, session } = await requireSession()
  await removePasskey({ request, session, passkeyId, assertion })
  return { id: passkeyId }
}

// ── What is protected ───────────────────────────────────────────────

// Raising protection needs a passkey on the account, so nobody locks an
// environment that no one can unlock.
async function requireOwnPasskey(request: Request, userId: string) {
  const passkeys = await listPasskeys({ request, userId })
  if (passkeys.length === 0) throw new Error('Add a passkey first.')
}

const setReadApprovalInput = z.object({
  environmentId: idSchema,
  readApproval: readApprovalSchema,
  assertion: webAuthnResponseSchema.optional(),
})

export async function setReadApprovalAction(input: z.input<typeof setReadApprovalInput>) {
  const { environmentId, readApproval, assertion } = parseInput(setReadApprovalInput, input)
  const { request, session } = await requireSession()
  await requireEnvironmentAdmin(session.userId, environmentId)
  const db = getDb()
  const environment = await db.query.environment.findFirst({ where: { id: environmentId } })
  if (!environment) throw new Error('Environment not found')
  if (environment.readApproval === readApproval) return { environmentId, readApproval }

  if (PROTECTION_LEVEL[readApproval] < PROTECTION_LEVEL[environment.readApproval]) {
    await requirePasskey({ request, session, intent: { kind: 'set-read-approval', environmentId, readApproval }, assertion })
  } else {
    await requireOwnPasskey(request, session.userId)
  }
  await db.update(schema.environment)
    .set({ readApproval, updatedAt: Date.now() })
    .where(orm.eq(schema.environment.id, environmentId))
    .limit(1)
  return { environmentId, readApproval }
}

// Any existing name can be protected, also legacy ones that fail today's name rules.
const secretApprovalInput = z.object({ environmentId: idSchema, name: z.string().min(1) })

export async function addSecretApprovalAction(input: z.input<typeof secretApprovalInput>) {
  const { environmentId, name } = parseInput(secretApprovalInput, input)
  const { request, session } = await requireSession()
  await requireEnvironmentAdmin(session.userId, environmentId)
  await requireOwnPasskey(request, session.userId)
  await getDb().insert(schema.secretApproval)
    .values({ environmentId, name, createdBy: session.userId })
    .onConflictDoNothing({ target: [schema.secretApproval.environmentId, schema.secretApproval.name] })
  return { environmentId, name }
}

const removeSecretApprovalInput = secretApprovalInput.extend({ assertion: webAuthnResponseSchema })

export async function removeSecretApprovalAction(input: z.input<typeof removeSecretApprovalInput>) {
  const { environmentId, name, assertion } = parseInput(removeSecretApprovalInput, input)
  const { request, session } = await requireSession()
  await requireEnvironmentAdmin(session.userId, environmentId)
  await requirePasskey({ request, session, intent: { kind: 'remove-secret-approval', environmentId, name }, assertion })
  await getDb().delete(schema.secretApproval)
    .where(orm.and(orm.eq(schema.secretApproval.environmentId, environmentId), orm.eq(schema.secretApproval.name, name)))
    .limit(1)
  return { environmentId, name }
}

// ── Requests ────────────────────────────────────────────────────────

async function requireRequest(requestId: string) {
  const request = await getRequestDetails(requestId)
  if (!request) throw new Error('Request not found')
  return request
}

const approveRequestInput = z.object({
  requestId: idSchema,
  // Items the user left checked, and every item the page showed.
  itemIds: z.array(idSchema),
  seenItemIds: z.array(idSchema),
  // API tokens only: keep the grant until someone revokes it.
  keep: z.boolean(),
  assertion: webAuthnResponseSchema,
})

export async function approveRequestAction(input: z.input<typeof approveRequestInput>) {
  const { requestId, itemIds, seenItemIds, keep, assertion } = parseInput(approveRequestInput, input)
  const { request, session } = await requireSession()
  const approvalRequest = await requireRequest(requestId)
  await approveRequest({
    request: approvalRequest, session, itemIds, seenItemIds, keep,
    confirm: () => requirePasskey({ request, session, intent: { kind: 'approve', requestId, itemIds, keep }, assertion }),
  })
  return { id: requestId }
}

const closeRequestInput = z.object({ requestId: idSchema })

export async function denyRequestAction(input: z.input<typeof closeRequestInput>) {
  const { requestId } = parseInput(closeRequestInput, input)
  const { session } = await requireSession()
  await closeRequest({ request: await requireRequest(requestId), session, status: 'denied' })
  return { id: requestId }
}

export async function revokeRequestAction(input: z.input<typeof closeRequestInput>) {
  const { requestId } = parseInput(closeRequestInput, input)
  const { session } = await requireSession()
  await closeRequest({ request: await requireRequest(requestId), session, status: 'revoked' })
  return { id: requestId }
}

// ── Website unlock ──────────────────────────────────────────────────

const unlockEnvironmentInput = z.object({ environmentId: idSchema, assertion: webAuthnResponseSchema })

// Unlocks the protected secrets of one environment for this browser session
// for 1 minute. Returns their values so the caller can finish what the user
// clicked (copy, download) without waiting for the page to load again.
export async function unlockEnvironmentAction(input: z.input<typeof unlockEnvironmentInput>) {
  const { environmentId, assertion } = parseInput(unlockEnvironmentInput, input)
  const { request, session } = await requireSession()
  const environment = await getUserEnvironmentAccess({ userId: session.userId, environmentRef: environmentId })
  if (!environment) throw new Error('Environment not found')
  const derived = await deriveSecrets(environment.id)
  const locked = new Set(await getLockedNames({
    credential: { sessionId: session.sessionId, apiTokenId: null },
    environment,
    names: derived.map((d) => d.name),
  }))
  await requirePasskey({ request, session, intent: { kind: 'unlock', environmentId: environment.id }, assertion })
  await unlockEnvironment({ session, environmentId: environment.id })
  const secrets = await Promise.all(
    derived.filter((d) => locked.has(d.name)).map(async (d) => ({ name: d.name, value: await decrypt(d.valueEncrypted, d.iv) })),
  )
  return { secrets }
}
