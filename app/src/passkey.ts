// WebAuthn passkeys used as proof that a human approved a sensitive action.
//
// A passkey assertion with user verification (Touch ID, security key PIN) is
// the only thing an agent cannot produce: it can hold the CLI session token and
// it can drive the user's logged-in browser, but it cannot touch the sensor.
//
// Every assertion is bound to one exact action (PasskeyIntent). The challenge
// is stored with the intent it was issued for, is single use and expires in
// 5 minutes, so an assertion made for "approve request A" cannot be replayed
// for "turn protection off".
//
// Registering a passkey grants nothing. An agent driving the browser can
// register a software key, so authority lives in org_passkey: each org trusts
// exact credentials.
//
//   register ──▶ passkey row (no authority)
//                   │ bootstrap: candidate signs, admin, browser, org never
//                   │ initialized and nothing protected (once per org)
//                   │ trust: a trusted admin passkey signs for this exact id
//                   ▼
//              org_passkey row ──▶ may sign org actions (approve, unlock, ...)
//
// org.trustInitializedAt is never cleared. Losing every trusted passkey locks
// the org until an operator trusts one by hand: no silent re-bootstrap.
//
// This deliberately does not use @better-auth/passkey: that plugin lets any
// session add a passkey that counts as proof, has no assertion bound to a
// custom payload, and adds passkey sign-in.

import * as orm from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { schema } from 'db'
import { ForbiddenError, getAuth, getDb, getOrgIdForEnvironment, getOrgIdForProject, getRequestOrigin, type Session } from './db.ts'
import { PASSKEY_REQUIRED_MESSAGE } from './lib/utils.ts'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const PASSKEY_NAME_MAX_LENGTH = 60

const idSchema = z.string().min(1)
// null = all projects.
const projectIdsSchema = z.array(idSchema).nullable()

// Changes that hand out access. They need a passkey once the org has trust set
// up (guardAccessChange). Each names the exact final state the human approves.
const accessIntentSchemas = [
  z.object({ kind: z.literal('create-invite'), orgId: idSchema, projectIds: projectIdsSchema }),
  z.object({ kind: z.literal('promote-admin'), orgId: idSchema, memberId: idSchema }),
  z.object({ kind: z.literal('update-member-access'), orgId: idSchema, memberId: idSchema, projectIds: projectIdsSchema }),
  z.object({ kind: z.literal('set-environment-access-role'), orgId: idSchema, environmentId: idSchema, accessRole: z.enum(['admin', 'member']) }),
  z.object({ kind: z.literal('enable-auto-join'), orgId: idSchema, autoJoinDomain: z.string().min(1) }),
] as const
export type AccessIntent = z.infer<(typeof accessIntentSchemas)[number]>

// The exact action an assertion authorizes. Key order comes from the schema,
// so JSON.stringify of a parsed intent is a stable string to compare.
export const passkeyIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), requestId: idSchema, itemIds: z.array(idSchema), keep: z.boolean() }),
  z.object({ kind: z.literal('unlock'), environmentId: idSchema }),
  z.object({ kind: z.literal('set-read-approval'), environmentId: idSchema, readApproval: z.enum(['off', 'selected', 'all']) }),
  z.object({ kind: z.literal('remove-secret-approval'), environmentId: idSchema, name: z.string().min(1) }),
  z.object({ kind: z.literal('remove-passkey'), passkeyId: idSchema }),
  z.object({ kind: z.literal('bootstrap-passkey'), orgId: idSchema, passkeyId: idSchema }),
  z.object({ kind: z.literal('trust-passkey'), orgId: idSchema, passkeyId: idSchema }),
  // Only needed while the environment (or one of the project) is protected: the
  // approve page shows these names, and a deleted environment loses its protection.
  z.object({ kind: z.literal('rename-environment'), environmentId: idSchema, name: z.string().nullable(), slug: z.string().nullable() }),
  z.object({ kind: z.literal('delete-environment'), environmentId: idSchema }),
  z.object({ kind: z.literal('rename-project'), projectId: idSchema, name: z.string().min(1) }),
  ...accessIntentSchemas,
])
export type PasskeyIntent = z.infer<typeof passkeyIntentSchema>

// WebAuthn responses are opaque here: @simplewebauthn/server validates them.
// Only the fields this file reads itself are checked.
const webAuthnResponseShape = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().min(1) }),
})
export type WebAuthnResponse = RegistrationResponseJSON | AuthenticationResponseJSON
export const webAuthnResponseSchema = z.custom<WebAuthnResponse>(
  (value) => webAuthnResponseShape.safeParse(value).success,
  'Invalid passkey response',
)

function serializeIntent(intent: PasskeyIntent): string {
  const parsed = passkeyIntentSchema.parse(intent)
  if (parsed.kind === 'approve') return JSON.stringify({ ...parsed, itemIds: [...parsed.itemIds].sort() })
  return JSON.stringify(parsed)
}

// Passkeys are bound to the host (rpID). preview, production and every
// self-hosted domain have their own.
function getRelyingParty(request: Request) {
  const origin = getRequestOrigin(request)
  return { origin, rpId: new URL(origin).hostname }
}

function challengeIdentifier(userId: string, challenge: string) {
  return `passkey:${userId}:${challenge}`
}

async function storeChallenge({ userId, challenge, purpose }: { userId: string; challenge: string; purpose: string }) {
  const db = getDb()
  const now = Date.now()
  await db.batch([
    // Expired challenges of this user are dropped here, so the table stays small.
    db.delete(schema.verification).where(orm.and(
      orm.like(schema.verification.identifier, `passkey:${userId}:%`),
      orm.lt(schema.verification.expiresAt, new Date(now)),
    )),
    db.insert(schema.verification).values({
      identifier: challengeIdentifier(userId, challenge),
      value: purpose,
      expiresAt: new Date(now + CHALLENGE_TTL_MS),
    }),
  ] as const)
}

// Reads the challenge the authenticator signed, then deletes its row. Returns
// the challenge only when it was issued to this user for this exact purpose.
async function consumeChallenge({ userId, response, purpose }: { userId: string; response: WebAuthnResponse; purpose: string }): Promise<string> {
  const clientData = z.object({ challenge: z.string().min(1) }).safeParse(
    JSON.parse(isoBase64URL.toUTF8String(response.response.clientDataJSON)),
  )
  if (!clientData.success) throw new Error('Invalid passkey response')
  const challenge = clientData.data.challenge
  const db = getDb()
  const [row] = await db.delete(schema.verification)
    .where(orm.eq(schema.verification.identifier, challengeIdentifier(userId, challenge)))
    .limit(1)
    .returning({ value: schema.verification.value, expiresAt: schema.verification.expiresAt })
  if (!row || row.expiresAt.getTime() < Date.now()) throw new Error('Passkey prompt expired. Try again.')
  if (row.value !== purpose) throw new Error('This passkey confirmation was made for a different action.')
  return challenge
}

export async function listPasskeys({ request, userId }: { request: Request; userId: string }) {
  const { rpId } = getRelyingParty(request)
  return getDb().query.passkey.findMany({ where: { userId, rpId }, orderBy: { createdAt: 'asc' } })
}

// ── Org trust ───────────────────────────────────────────────────────

async function getOrgTrustState(orgId: string) {
  const db = getDb()
  const [org, protectedEnvironment] = await db.batch([
    db.query.org.findFirst({ where: { id: orgId } }),
    db.query.environment.findFirst({ where: { readApproval: { ne: 'off' }, project: { orgId } } }),
  ] as const)
  if (!org) throw new Error('Organization not found')
  return { initialized: org.trustInitializedAt != null, protected: !!protectedEnvironment }
}

// Environments of the org whose reads need approval. For write conditions.
function protectedEnvironments(orgId: string) {
  return getDb().select({ id: schema.environment.id })
    .from(schema.environment)
    .innerJoin(schema.project, orm.eq(schema.project.id, schema.environment.projectId))
    .where(orm.and(orm.eq(schema.project.orgId, orgId), orm.ne(schema.environment.readApproval, 'off')))
}

type TrustQuery = { request: Request; userId: string; orgIds: string[] }

// Trust rows of this user's passkeys on this host in `orgIds`. A row only
// counts while its owner is still a member of that org.
export async function listTrustedPasskeys({ request, userId, orgIds }: TrustQuery) {
  if (orgIds.length === 0) return []
  const { rpId } = getRelyingParty(request)
  return getDb().query.orgPasskey.findMany({
    where: { orgId: { in: [...new Set(orgIds)] }, passkey: { userId, rpId }, org: { members: { userId } } },
  })
}

// Ids of this user's passkeys on this host that every org in `orgIds` trusts.
async function getTrustedPasskeyIds({ request, userId, orgIds }: TrustQuery): Promise<Set<string>> {
  const wanted = new Set(orgIds)
  const rows = await listTrustedPasskeys({ request, userId, orgIds })
  const orgsByPasskey = new Map<string, Set<string>>()
  for (const row of rows) orgsByPasskey.set(row.passkeyId, (orgsByPasskey.get(row.passkeyId) ?? new Set()).add(row.orgId))
  return new Set([...orgsByPasskey].filter(([, orgs]) => orgs.size === wanted.size).map(([id]) => id))
}

// Orgs where this user's passkey `passkeyId` is trusted and the user is still a member.
async function getPasskeyTrustOrgIds({ userId, passkeyId }: { userId: string; passkeyId: string }) {
  const rows = await getDb().query.orgPasskey.findMany({
    where: { passkeyId, passkey: { userId }, org: { members: { userId } } },
  })
  return rows.map((row) => row.orgId)
}

// Orgs whose trusted passkey must sign this intent. [] = any own passkey:
// only when the user removes a passkey that no org trusts.
async function getIntentOrgIds({ userId, intent }: { userId: string; intent: PasskeyIntent }): Promise<string[]> {
  switch (intent.kind) {
    case 'approve': {
      if (intent.itemIds.length === 0) throw new Error('Select at least one item to approve.')
      const items = await getDb().query.approvalItem.findMany({
        where: { requestId: intent.requestId, id: { in: intent.itemIds } },
        with: { environment: { with: { project: true } } },
      })
      const orgIds = items.map((item) => item.environment?.project?.orgId).filter((id): id is string => !!id)
      if (items.length !== new Set(intent.itemIds).size || orgIds.length !== items.length) {
        throw new Error('This request changed. Review it again.')
      }
      return [...new Set(orgIds)]
    }
    case 'unlock':
    case 'set-read-approval':
    case 'remove-secret-approval':
    case 'rename-environment':
    case 'delete-environment': {
      const orgId = await getOrgIdForEnvironment(intent.environmentId)
      if (!orgId) throw new Error('Environment not found')
      return [orgId]
    }
    case 'rename-project': {
      const orgId = await getOrgIdForProject(intent.projectId)
      if (!orgId) throw new Error('Project not found')
      return [orgId]
    }
    case 'bootstrap-passkey':
    case 'trust-passkey':
    case 'create-invite':
    case 'promote-admin':
    case 'update-member-access':
    case 'set-environment-access-role':
    case 'enable-auto-join':
      return [intent.orgId]
    case 'remove-passkey':
      return getPasskeyTrustOrgIds({ userId, passkeyId: intent.passkeyId })
  }
}

async function requireOrgAdmin({ userId, orgId, message }: { userId: string; orgId: string; message: string }) {
  const member = await getDb().query.orgMember.findFirst({ where: { orgId, userId } })
  if (!member) throw new ForbiddenError()
  if (member.role !== 'admin') throw new Error(message)
}

// Reads the session kind from D1. getSession() may answer from better-auth's
// signed 5 minute session_data cookie, which is not checked against the bearer
// token: a device login could replay one signed before 0012 marked it 'cli'.
async function requireBrowserSession({ request, session, message }: { request: Request; session: Session; message: string }) {
  const auth = await getAuth(request)
  const stored = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true, disableRefresh: true } })
  if (stored?.session.id !== session.sessionId || stored.session.kind !== 'browser') throw new Error(message)
}

// Checked before the prompt and again before the write, so nobody touches the
// sensor for a bootstrap that will be refused.
async function assertCanBootstrap({ request, session, orgId }: { request: Request; session: Session; orgId: string }) {
  await requireBrowserSession({ request, session, message: 'Set up the first trusted passkey from the dashboard in a browser, not from a CLI session.' })
  await requireOrgAdmin({ userId: session.userId, orgId, message: 'Only admins can set up trusted passkeys.' })
  const state = await getOrgTrustState(orgId)
  if (state.initialized) throw new Error('Passkey setup for this organization is done. An admin with a trusted passkey must trust yours.')
  if (state.protected) throw new Error('This organization protects environments but trusts no passkey. An operator must trust the first passkey.')
}

// ── Registration ────────────────────────────────────────────────────

// A new passkey has no authority in any org, so registration needs no
// assertion. Browser only, so CLI tokens agents read from disk cannot fill the
// trust list with look-alike candidates.
const REGISTER_IN_BROWSER = 'Add passkeys from the dashboard in a browser, not from a CLI session.'

export async function startPasskeyRegistration({ request, session }: { request: Request; session: Session }) {
  await requireBrowserSession({ request, session, message: REGISTER_IN_BROWSER })
  const { rpId } = getRelyingParty(request)
  const existing = await listPasskeys({ request, userId: session.userId })
  const options = await generateRegistrationOptions({
    rpName: 'Sigillo',
    rpID: rpId,
    userName: session.user.email,
    userDisplayName: session.user.name,
    userID: new TextEncoder().encode(session.userId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: toTransports(p.transports) })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  })
  await storeChallenge({ userId: session.userId, challenge: options.challenge, purpose: 'register' })
  return options
}

export async function finishPasskeyRegistration({ request, session, response, name }: {
  request: Request
  session: Session
  response: WebAuthnResponse
  name: string
}) {
  // Again here: the challenge belongs to the user, not to the session that started.
  await requireBrowserSession({ request, session, message: REGISTER_IN_BROWSER })
  const { origin, rpId } = getRelyingParty(request)
  const challenge = await consumeChallenge({ userId: session.userId, response, purpose: 'register' })
  const verification = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    requireUserVerification: true,
  }).catch(() => null)
  if (!verification?.verified || !verification.registrationInfo) throw new Error('Passkey could not be verified')

  const { credential } = verification.registrationInfo
  const [row] = await getDb().insert(schema.passkey).values({
    userId: session.userId,
    name: name.trim().slice(0, PASSKEY_NAME_MAX_LENGTH) || 'Passkey',
    credentialId: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? null,
    rpId,
  }).returning({ id: schema.passkey.id })
  return { id: row!.id }
}

// ── Assertions ──────────────────────────────────────────────────────

// Offers only the passkeys that can sign this intent: the candidate for a
// bootstrap, keys trusted by every involved org for org actions.
export async function startPasskeyAssertion({ request, session, intent }: {
  request: Request
  session: Session
  intent: PasskeyIntent
}) {
  const { rpId } = getRelyingParty(request)
  const passkeys = await listPasskeys({ request, userId: session.userId })
  if (passkeys.length === 0) throw new Error('Add a passkey in Settings first.')
  let allowed = passkeys
  if (intent.kind === 'bootstrap-passkey') {
    await assertCanBootstrap({ request, session, orgId: intent.orgId })
    allowed = passkeys.filter((p) => p.id === intent.passkeyId)
    if (allowed.length === 0) throw new Error('Passkey not found')
  } else {
    const orgIds = await getIntentOrgIds({ userId: session.userId, intent })
    if (orgIds.length > 0) {
      const trusted = await getTrustedPasskeyIds({ request, userId: session.userId, orgIds })
      allowed = passkeys.filter((p) => trusted.has(p.id))
      if (allowed.length === 0) throw new Error('None of your passkeys is trusted in this organization. Ask an admin to trust one in Settings.')
    }
  }
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: allowed.map((p) => ({ id: p.credentialId, transports: toTransports(p.transports) })),
    userVerification: 'required',
  })
  await storeChallenge({ userId: session.userId, challenge: options.challenge, purpose: serializeIntent(intent) })
  return options
}

// Verifies that `assertion` is a fresh signature by one of this user's
// passkeys for exactly this intent. Says nothing about org trust.
async function verifyAssertion({ request, session, intent, assertion }: {
  request: Request
  session: Session
  intent: PasskeyIntent
  assertion: WebAuthnResponse
}) {
  const { origin, rpId } = getRelyingParty(request)
  const db = getDb()
  const passkey = await db.query.passkey.findFirst({
    where: { userId: session.userId, rpId, credentialId: assertion.id },
  })
  if (!passkey) throw new Error('Unknown passkey')
  const challenge = await consumeChallenge({ userId: session.userId, response: assertion, purpose: serializeIntent(intent) })
  const verification = await verifyAuthenticationResponse({
    response: assertion as AuthenticationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: passkey.credentialId,
      publicKey: isoBase64URL.toBuffer(passkey.publicKey),
      counter: passkey.counter,
      transports: toTransports(passkey.transports),
    },
    requireUserVerification: true,
  }).catch(() => null)
  if (!verification?.verified) throw new Error('Passkey could not be verified')
  await db.update(schema.passkey)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: Date.now() })
    .where(orm.eq(schema.passkey.id, passkey.id))
    .limit(1)
  return passkey
}

// Throws unless `assertion` is a fresh signature for exactly this intent by a
// passkey of this user that every org the intent touches trusts. The orgs come
// from the intent itself (environment, approved items, orgId), so a caller
// cannot forget the trust check.
//
// Trust is checked at decision time. A write that follows (a grant, a setting)
// stays valid if the trust is removed later; removing trust does not revoke
// grants or undo settings, same as removing a passkey.
//
// Returns the passkey that signed.
export async function requirePasskey({ request, session, intent, assertion }: {
  request: Request
  session: Session
  intent: PasskeyIntent
  assertion: WebAuthnResponse | undefined
}) {
  if (!assertion) throw new Error(PASSKEY_REQUIRED_MESSAGE)
  const orgIds = await getIntentOrgIds({ userId: session.userId, intent })
  const passkey = await verifyAssertion({ request, session, intent, assertion })
  if (orgIds.length > 0) {
    const trusted = await getTrustedPasskeyIds({ request, userId: session.userId, orgIds })
    if (!trusted.has(passkey.id)) throw new Error('This passkey is not trusted in this organization. Ask an admin to trust it in Settings.')
  }
  return passkey
}

// Raising protection or adding a protected secret: the user must hold a passkey
// the org trusts, so nobody locks an environment that no one can unlock. This
// also keeps "protected" implying "trust initialized".
export async function requireOwnTrustedPasskey({ request, session, environmentId }: {
  request: Request
  session: Session
  environmentId: string
}): Promise<void> {
  const orgId = await getOrgIdForEnvironment(environmentId)
  if (!orgId) throw new Error('Environment not found')
  const trusted = await listTrustedPasskeys({ request, userId: session.userId, orgIds: [orgId] })
  if (trusted.length === 0) throw new Error('Set up a trusted passkey for this organization in Settings first.')
}

// Gate for changes that hand out access. Open until the org sets up trust or
// protects something; after that, a trusted passkey must sign this exact intent.
//
// Returns a condition the write MUST include. When a passkey was verified
// there is none: trust setup is sticky. When the gate was open, setup can
// finish before the write lands, so the write applies only if the org is
// still open at write time.
export async function guardAccessChange({ request, session, intent, assertion }: {
  request: Request
  session: Session
  intent: AccessIntent
  assertion: WebAuthnResponse | undefined
}): Promise<orm.SQL | undefined> {
  const state = await getOrgTrustState(intent.orgId)
  if (state.initialized || state.protected) {
    await requirePasskey({ request, session, intent, assertion })
    return undefined
  }
  // Same rule as above, evaluated inside the write.
  return orm.and(
    orm.exists(getDb().select({ id: schema.org.id }).from(schema.org).where(orm.and(
      orm.eq(schema.org.id, intent.orgId),
      orm.isNull(schema.org.trustInitializedAt),
    ))),
    orm.notExists(protectedEnvironments(intent.orgId)),
  )
}

// ── Trusting passkeys ───────────────────────────────────────────────

// The first trusted passkey of an org. The candidate signs for itself: the
// server cannot tell a human from a software key, so this is only allowed once
// per org, from a browser, by an admin, before anything is protected. Invite
// links and domain auto-join made before it were not gated, so they go.
export async function bootstrapOrgPasskey({ request, session, orgId, passkeyId, assertion }: {
  request: Request
  session: Session
  orgId: string
  passkeyId: string
  assertion: WebAuthnResponse
}): Promise<void> {
  await assertCanBootstrap({ request, session, orgId })
  const signer = await verifyAssertion({ request, session, intent: { kind: 'bootstrap-passkey', orgId, passkeyId }, assertion })
  if (signer.id !== passkeyId) throw new Error('Confirm with the passkey you are trusting.')

  const db = getDb()
  const now = Date.now()
  const rowId = ulid()
  // One batch is one transaction. Every statement after the insert checks the
  // inserted row, so two racing bootstraps cannot both win.
  const inserted = orm.exists(db.select({ id: schema.orgPasskey.id }).from(schema.orgPasskey).where(orm.eq(schema.orgPasskey.id, rowId)))
  await db.batch([
    db.insert(schema.orgPasskey).select((qb) => qb
      .select({
        id: orm.sql<string>`${rowId}`.as('id'),
        orgId: schema.org.id,
        passkeyId: orm.sql<string>`${passkeyId}`.as('passkey_id'),
        trustedBy: orm.sql<string>`${session.userId}`.as('trusted_by'),
        createdAt: orm.sql<number>`${now}`.as('created_at'),
      })
      .from(schema.org)
      .where(orm.and(
        orm.eq(schema.org.id, orgId),
        orm.isNull(schema.org.trustInitializedAt),
        orm.notExists(protectedEnvironments(orgId)),
        orm.exists(db.select({ id: schema.orgMember.id }).from(schema.orgMember).where(orm.and(
          orm.eq(schema.orgMember.orgId, orgId),
          orm.eq(schema.orgMember.userId, session.userId),
          orm.eq(schema.orgMember.role, 'admin'),
        ))),
      ))),
    db.update(schema.org)
      .set({ trustInitializedAt: now, autoJoinDomain: null, updatedAt: now })
      .where(orm.and(orm.eq(schema.org.id, orgId), inserted))
      .limit(1),
    db.delete(schema.orgInvitation).where(orm.and(orm.eq(schema.orgInvitation.orgId, orgId), inserted)),
  ] as const)
  const row = await db.query.orgPasskey.findFirst({ where: { id: rowId } })
  if (!row) throw new Error('Passkey setup or your role changed meanwhile. Reload and try again.')
}

// A trusted admin passkey trusts one exact candidate passkey of a member. The
// intent names the candidate id, so a key enrolled meanwhile by someone else
// is never trusted by accident.
export async function trustOrgPasskey({ request, session, orgId, passkeyId, assertion }: {
  request: Request
  session: Session
  orgId: string
  passkeyId: string
  assertion: WebAuthnResponse | undefined
}): Promise<void> {
  await requireOrgAdmin({ userId: session.userId, orgId, message: 'Only admins can trust passkeys.' })
  const db = getDb()
  const { rpId } = getRelyingParty(request)
  const candidate = await db.query.passkey.findFirst({
    where: { id: passkeyId, rpId, user: { orgs: { id: orgId } } },
  })
  if (!candidate) throw new Error('Passkey not found')
  const signer = await requirePasskey({ request, session, intent: { kind: 'trust-passkey', orgId, passkeyId }, assertion })

  // Re-checked in the insert itself: the signer is still trusted here and
  // still an admin, and the candidate's owner is still a member.
  const isMember = (userId: string, role?: 'admin') => orm.exists(db.select({ id: schema.orgMember.id })
    .from(schema.orgMember)
    .where(orm.and(
      orm.eq(schema.orgMember.orgId, orgId),
      orm.eq(schema.orgMember.userId, userId),
      role ? orm.eq(schema.orgMember.role, role) : undefined,
    )))
  await db.insert(schema.orgPasskey)
    .select((qb) => qb
      .select({
        id: orm.sql<string>`${ulid()}`.as('id'),
        orgId: schema.orgPasskey.orgId,
        passkeyId: orm.sql<string>`${passkeyId}`.as('passkey_id'),
        trustedBy: orm.sql<string>`${session.userId}`.as('trusted_by'),
        createdAt: orm.sql<number>`${Date.now()}`.as('created_at'),
      })
      .from(schema.orgPasskey)
      .where(orm.and(
        orm.eq(schema.orgPasskey.orgId, orgId),
        orm.eq(schema.orgPasskey.passkeyId, signer.id),
        isMember(session.userId, 'admin'),
        isMember(candidate.userId),
      )))
    .onConflictDoNothing()
  const row = await db.query.orgPasskey.findFirst({ where: { orgId, passkeyId } })
  if (!row) throw new Error('Your access changed meanwhile. Reload and try again.')
}

// Settings view. Admins see the passkeys of every member (trust candidates),
// members only their own.
export async function listOrgPasskeys({ request, session, orgId }: { request: Request; session: Session; orgId: string }) {
  const { rpId } = getRelyingParty(request)
  const [state, members] = await Promise.all([
    getOrgTrustState(orgId),
    getDb().query.orgMember.findMany({
      where: { orgId },
      with: { user: { with: { passkeys: { where: { rpId }, with: { orgTrusts: { where: { orgId } } } } } } },
    }),
  ])
  const me = members.find((member) => member.userId === session.userId)
  if (!me) throw new ForbiddenError()
  const visible = me.role === 'admin' ? members : [me]
  const passkeys = visible
    .flatMap((member) => (member.user?.passkeys ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      userId: member.userId,
      userName: member.user!.name,
      credentialId: p.credentialId,
      trusted: p.orgTrusts.length > 0,
      createdAt: p.createdAt,
      lastUsedAt: p.lastUsedAt,
    })))
    .sort((a, b) => a.createdAt - b.createdAt)
  return {
    initialized: state.initialized,
    canBootstrap: !state.initialized && !state.protected && me.role === 'admin' && session.kind === 'browser',
    passkeys,
  }
}

// ── Removing ────────────────────────────────────────────────────────

// Trusted passkeys whose owner is an admin of that org: the only keys that can
// trust a new one. `where` filters on o (org_passkey), p (passkey) and
// m (org_member).
function trustedAdminPasskeys(where: orm.SQL) {
  return orm.sql`
    select 1 from org_passkey o
    join passkey p on p.id = o.passkey_id
    join org_member m on m.org_id = o.org_id and m.user_id = p.user_id and m.role = 'admin'
    where ${where}`
}

// Write condition for removing or demoting a member. False only when `userId`
// is the last admin with a trusted passkey in the org: without one, nobody
// could trust a new key. In the write itself, so two concurrent changes cannot
// drop the last two.
export function keepsTrustedAdmin({ orgId, userId }: { orgId: string; userId: string }) {
  return orm.sql`(
    not exists (${trustedAdminPasskeys(orm.sql`o.org_id = ${orgId} and p.user_id = ${userId}`)})
    or exists (${trustedAdminPasskeys(orm.sql`o.org_id = ${orgId} and p.user_id != ${userId}`)})
  )`
}

// Needs a passkey trusted wherever the removed one is trusted (it can be the
// removed one itself). Refused when no other trusted admin passkey would be
// left in one of those orgs: nobody could trust a new one after that. A lost
// device or a deleted account can still leave an org with none; then only an
// operator can restore one.
export async function removePasskey({ request, session, passkeyId, assertion }: {
  request: Request
  session: Session
  passkeyId: string
  assertion: WebAuthnResponse | undefined
}) {
  const db = getDb()
  const target = await db.query.passkey.findFirst({ where: { id: passkeyId, userId: session.userId } })
  if (!target) throw new Error('Passkey not found')
  await requirePasskey({ request, session, intent: { kind: 'remove-passkey', passkeyId }, assertion })
  // In the delete itself, so two removals at once cannot drop the last two keys.
  const [deleted] = await db.delete(schema.passkey)
    .where(orm.and(
      orm.eq(schema.passkey.id, passkeyId),
      orm.eq(schema.passkey.userId, session.userId),
      orm.sql`not exists (
        select 1 from org_passkey t where t.passkey_id = ${passkeyId}
        and not exists (${trustedAdminPasskeys(orm.sql`o.org_id = t.org_id and o.passkey_id != t.passkey_id`)})
      )`,
    ))
    .limit(1)
    .returning({ id: schema.passkey.id })
  if (!deleted) throw new Error('This is the last trusted admin passkey of an organization. Trust another admin passkey there first.')
}

const KNOWN_TRANSPORTS: AuthenticatorTransport[] = ['ble', 'hybrid', 'internal', 'nfc', 'usb']

function toTransports(value: string[] | null): AuthenticatorTransport[] | undefined {
  if (!value) return undefined
  return KNOWN_TRANSPORTS.filter((transport) => value.includes(transport))
}
