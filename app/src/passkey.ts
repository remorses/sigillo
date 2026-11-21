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
// This deliberately does not use @better-auth/passkey: that plugin lets any
// session add a passkey (an agent could enroll its own and approve itself),
// has no assertion bound to a custom payload, and adds passkey sign-in.

import * as orm from 'drizzle-orm'
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
import { getDb, getRequestOrigin, type Session } from './db.ts'

const CHALLENGE_TTL_MS = 5 * 60 * 1000
const PASSKEY_NAME_MAX_LENGTH = 60

const idSchema = z.string().min(1)

// The exact action an assertion authorizes. Key order comes from the schema,
// so JSON.stringify of a parsed intent is a stable string to compare.
export const passkeyIntentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve'), requestId: idSchema, itemIds: z.array(idSchema), keep: z.boolean() }),
  z.object({ kind: z.literal('unlock'), environmentId: idSchema }),
  z.object({ kind: z.literal('set-read-approval'), environmentId: idSchema, readApproval: z.enum(['off', 'selected', 'all']) }),
  z.object({ kind: z.literal('remove-secret-approval'), environmentId: idSchema, name: z.string().min(1) }),
  z.object({ kind: z.literal('add-passkey') }),
  z.object({ kind: z.literal('remove-passkey'), passkeyId: idSchema }),
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
      orm.lt(schema.verification.expiresAt, now),
    )),
    db.insert(schema.verification).values({
      identifier: challengeIdentifier(userId, challenge),
      value: purpose,
      expiresAt: now + CHALLENGE_TTL_MS,
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
  if (!row || row.expiresAt < Date.now()) throw new Error('Passkey prompt expired. Try again.')
  if (row.value !== purpose) throw new Error('This passkey confirmation was made for a different action.')
  return challenge
}

export async function listPasskeys({ request, userId }: { request: Request; userId: string }) {
  const { rpId } = getRelyingParty(request)
  return getDb().query.passkey.findMany({ where: { userId, rpId }, orderBy: { createdAt: 'asc' } })
}

// Enrolling the FIRST passkey is trust on first use, so it is the weak spot:
// it must be a browser session, never the CLI token agents can read from disk.
// Every later passkey needs an assertion from an existing one.
export async function startPasskeyRegistration({ request, session, assertion }: {
  request: Request
  session: Session
  assertion?: WebAuthnResponse
}) {
  const { rpId } = getRelyingParty(request)
  // "First" means first on ANY host. One instance can answer on several hosts
  // (custom domain plus *.workers.dev) and they share grants, so a user with a
  // passkey on one host must not get a free enrollment on another.
  const all = await getDb().query.passkey.findMany({ where: { userId: session.userId } })
  const existing = all.filter((p) => p.rpId === rpId)
  if (existing.length > 0) {
    await requirePasskey({ request, session, intent: { kind: 'add-passkey' }, assertion })
  } else if (all.length > 0) {
    throw new Error(`Your passkeys belong to ${all[0]!.rpId}. Open Sigillo on that domain to approve or to manage passkeys.`)
  } else if (session.kind !== 'browser') {
    throw new Error('Add your first passkey from the dashboard in a browser, not from a CLI session.')
  }

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

export async function startPasskeyAssertion({ request, session, intent }: {
  request: Request
  session: Session
  intent: PasskeyIntent
}) {
  const { rpId } = getRelyingParty(request)
  const passkeys = await listPasskeys({ request, userId: session.userId })
  if (passkeys.length === 0) throw new Error('Add a passkey in Settings first.')
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: toTransports(p.transports) })),
    userVerification: 'required',
  })
  await storeChallenge({ userId: session.userId, challenge: options.challenge, purpose: serializeIntent(intent) })
  return options
}

// Throws unless `assertion` is a fresh passkey signature by this user for
// exactly this intent.
export async function requirePasskey({ request, session, intent, assertion }: {
  request: Request
  session: Session
  intent: PasskeyIntent
  assertion: WebAuthnResponse | undefined
}): Promise<void> {
  if (!assertion) throw new Error('Passkey confirmation required')
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
}

export async function removePasskey({ request, session, passkeyId, assertion }: {
  request: Request
  session: Session
  passkeyId: string
  assertion: WebAuthnResponse | undefined
}) {
  await requirePasskey({ request, session, intent: { kind: 'remove-passkey', passkeyId }, assertion })
  await getDb().delete(schema.passkey)
    .where(orm.and(orm.eq(schema.passkey.id, passkeyId), orm.eq(schema.passkey.userId, session.userId)))
    .limit(1)
}

const KNOWN_TRANSPORTS: AuthenticatorTransport[] = ['ble', 'hybrid', 'internal', 'nfc', 'usb']

function toTransports(value: string[] | null): AuthenticatorTransport[] | undefined {
  if (!value) return undefined
  return KNOWN_TRANSPORTS.filter((transport) => value.includes(transport))
}
