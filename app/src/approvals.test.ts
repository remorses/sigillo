// Integration tests for passkey approvals. Same setup as app.test.ts: real
// workerd, real D1, real AES-GCM, no mocks.
//
// Passkeys are exercised with a software authenticator: a real P-256 key that
// builds real WebAuthn registration and assertion responses, verified by the
// real @simplewebauthn/server code. It also shows why the first passkey is
// the weak spot: anything that can call the actions can be an authenticator.

import { describe, test, expect } from 'vitest'
import { createSpiceflowFetch } from 'spiceflow/client'
import { runAction } from 'spiceflow/testing'
import * as orm from 'drizzle-orm'
import { schema } from 'db'
import { app } from './app.js'
import { getAuth, getDb, getSession, generateApiToken } from './db.js'
import {
  createInviteAction,
  removeOrgMemberAction,
  syncMissingSecretsAction,
  updateEnvironmentAccessRoleAction,
  updateMemberAccessAction,
  updateOrgMemberRoleAction,
  updateAutoJoinDomainAction,
} from './actions.js'
import {
  addSecretApprovalAction,
  approveRequestAction,
  bootstrapOrgPasskeyAction,
  finishPasskeyRegistrationAction,
  removePasskeyAction,
  removeSecretApprovalAction,
  revokeRequestAction,
  setReadApprovalAction,
  startPasskeyAssertionAction,
  startPasskeyRegistrationAction,
  trustOrgPasskeyAction,
  unlockEnvironmentAction,
} from './approval-actions.js'
import { listOrgPasskeys, type PasskeyIntent } from './passkey.js'

const ORIGIN = 'http://e.ly'
const RP_ID = 'e.ly'

// ── Software authenticator ──────────────────────────────────────────

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function b64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

async function sha256(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
}

// Minimal CBOR: just the shapes WebAuthn needs.
function cborHead(major: number, n: number) {
  if (n < 24) return new Uint8Array([(major << 5) | n])
  if (n < 256) return new Uint8Array([(major << 5) | 24, n])
  return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff])
}
function cborInt(n: number) {
  return n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n)
}
function cborBytes(bytes: Uint8Array) {
  return concat(cborHead(2, bytes.length), bytes)
}
function cborText(text: string) {
  const bytes = new TextEncoder().encode(text)
  return concat(cborHead(3, bytes.length), bytes)
}
function cborMap(entries: Array<[Uint8Array, Uint8Array]>) {
  return concat(cborHead(5, entries.length), ...entries.flat())
}

// WebCrypto signs as raw r||s, WebAuthn wants ASN.1 DER.
function derSignature(raw: Uint8Array) {
  const int = (bytes: Uint8Array) => {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const trimmed = bytes.slice(i)
    const body = trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed
    return concat(new Uint8Array([0x02, body.length]), body)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

async function createAuthenticator() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const id = b64url(credentialId)
  const rpIdHash = await sha256(new TextEncoder().encode(RP_ID))
  let counter = 0

  function clientData(type: string, challenge: string) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }))
  }

  return {
    id,
    async register(options: { challenge: string }) {
      const cosePublicKey = cborMap([
        [cborInt(1), cborInt(2)],
        [cborInt(3), cborInt(-7)],
        [cborInt(-1), cborInt(1)],
        [cborInt(-2), cborBytes(fromB64url(jwk.x!))],
        [cborInt(-3), cborBytes(fromB64url(jwk.y!))],
      ])
      // flags: user present, user verified, attested credential data
      const authData = concat(
        rpIdHash, new Uint8Array([0x45]), new Uint8Array(4), new Uint8Array(16),
        new Uint8Array([0, credentialId.length]), credentialId, cosePublicKey,
      )
      const attestationObject = cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData)],
      ])
      return {
        id, rawId: id, type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge)),
          attestationObject: b64url(attestationObject),
          transports: ['internal'],
        },
        clientExtensionResults: {},
      }
    },
    async assert(options: { challenge: string }) {
      counter += 1
      const authData = concat(rpIdHash, new Uint8Array([0x05]), new Uint8Array([0, 0, 0, counter]))
      const clientDataJSON = clientData('webauthn.get', options.challenge)
      const signature = new Uint8Array(await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, concat(authData, await sha256(clientDataJSON)),
      ))
      return {
        id, rawId: id, type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(derSignature(signature)),
        },
        clientExtensionResults: {},
      }
    },
  }
}

type Authenticator = Awaited<ReturnType<typeof createAuthenticator>>

// ── Helpers ─────────────────────────────────────────────────────────

async function createUser() {
  const auth = await getAuth(new Request(ORIGIN))
  const email = `approvals-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const res = await auth.api.signUpEmail({ body: { email, name: 'Ada', password: 'test-password-123' } })
  return { userId: res.user.id, token: res.token! }
}

// A second login of the same user that came through the CLI device flow.
async function createCliSession(browserToken: string) {
  const auth = await getAuth(new Request(ORIGIN))
  const code = await auth.api.deviceCode({ body: { client_id: 'sigillo-cli' } })
  const headers = { authorization: `Bearer ${browserToken}` }
  await auth.api.deviceVerify({ query: { user_code: code.user_code }, headers })
  await auth.api.deviceApprove({ body: { userCode: code.user_code }, headers })
  const token = await auth.api.deviceToken({
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: 'sigillo-cli' },
  })
  return token.access_token
}

function actionRequest(token: string) {
  return new Request(ORIGIN, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
}

function act<T>(token: string, fn: () => Promise<T>) {
  return runAction(fn, { request: actionRequest(token) })
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function confirm(token: string, authenticator: Authenticator, intent: PasskeyIntent) {
  const { options } = await act(token, () => startPasskeyAssertionAction({ intent }))
  return authenticator.assert(options)
}

type Key = { authenticator: Authenticator; passkeyId: string }

async function enroll(token: string, name = 'Test key'): Promise<Key> {
  const authenticator = await createAuthenticator()
  const { options } = await act(token, () => startPasskeyRegistrationAction({}))
  const passkey = await act(token, async () => finishPasskeyRegistrationAction({ response: await authenticator.register(options), name }))
  return { authenticator, passkeyId: passkey.id }
}

// The explicit first-trust setup: the candidate signs for itself.
async function bootstrap(token: string, key: Key, orgId: string) {
  const assertion = await confirm(token, key.authenticator, { kind: 'bootstrap-passkey', orgId, passkeyId: key.passkeyId })
  return act(token, () => bootstrapOrgPasskeyAction({ orgId, passkeyId: key.passkeyId, assertion }))
}

async function trust(token: string, signer: Key, orgId: string, passkeyId: string) {
  const assertion = await confirm(token, signer.authenticator, { kind: 'trust-passkey', orgId, passkeyId })
  return act(token, () => trustOrgPasskeyAction({ orgId, passkeyId, assertion }))
}

async function orgPasskeys(token: string, orgId: string) {
  const request = actionRequest(token)
  const session = await getSession(request)
  const result = await listOrgPasskeys({ request, session: session!, orgId })
  return {
    initialized: result.initialized,
    canBootstrap: result.canBootstrap,
    passkeys: result.passkeys.map((p) => `${p.name}:${p.trusted ? 'trusted' : 'untrusted'}`),
  }
}

async function addMember(orgId: string, role: 'admin' | 'member' = 'member') {
  const member = await createUser()
  const [row] = await getDb().insert(schema.orgMember).values({ orgId, userId: member.userId, role }).returning()
  return { ...member, memberId: row!.id }
}

function api(token: string) {
  return createSpiceflowFetch(app, { headers: { authorization: `Bearer ${token}` } })
}

// Raw fetch: the 403 body carries the approval fields the CLI reads.
async function read(token: string, path: string) {
  const res = await app.handle(new Request(`${ORIGIN}${path}`, { headers: { authorization: `Bearer ${token}` } }))
  const body: Record<string, any> = await res.json()
  return { status: res.status, body }
}

async function createProject(token: string, secrets: Record<string, Record<string, string>>) {
  const f = api(token)
  const org = await f('/api/v0/orgs', { method: 'POST', body: { name: 'Approvals org' } })
  if (org instanceof Error) throw org
  const project = await f('/api/v0/projects', { method: 'POST', body: { name: 'website', orgId: org.id } })
  if (project instanceof Error) throw project
  const envs = await f('/api/v0/projects/:projectId/environments', { params: { projectId: project.id } })
  if (envs instanceof Error) throw envs
  const envId = (slug: string) => envs.environments.find((env) => env.slug === slug)!.id
  for (const [slug, values] of Object.entries(secrets)) {
    const res = await f('/api/v0/projects/:projectId/environments/:environmentId/secrets', {
      method: 'PUT', params: { projectId: project.id, environmentId: slug }, body: { secrets: values },
    })
    if (res instanceof Error) throw res
  }
  return { orgId: org.id, projectId: project.id, envId }
}

async function pendingRequest(requestId: string) {
  const request = await getDb().query.approvalRequest.findFirst({ where: { id: requestId }, with: { items: true } })
  return request!
}

// ── Tests ───────────────────────────────────────────────────────────

describe('passkeys', () => {
  test('registration needs a browser session but no assertion, removal needs one, assertions are single use and bound to one action', async () => {
    const user = await createUser()
    const cliToken = await createCliSession(user.token)
    const db = getDb()
    const sessions = await db.query.session.findMany({ where: { userId: user.userId }, orderBy: { createdAt: 'asc' } })
    expect(sessions.map((s) => s.kind)).toMatchInlineSnapshot(`
      [
        "browser",
        "cli",
      ]
    `)

    // The CLI token sits in a file agents can read: it must not enroll.
    expect(await act(cliToken, () => startPasskeyRegistrationAction({})).catch(message)).toMatchInlineSnapshot(`"Add passkeys from the dashboard in a browser, not from a CLI session."`)

    // A new passkey has no authority anywhere, so no assertion is needed to add one.
    const { authenticator, passkeyId } = await enroll(user.token)
    const second = await enroll(user.token, 'Second')
    expect(await db.query.passkey.findMany({ where: { userId: user.userId } })).toHaveLength(2)

    // An assertion made for one action does not authorize another.
    const wrongIntent = await confirm(user.token, authenticator, { kind: 'remove-passkey', passkeyId: second.passkeyId })
    expect(await act(user.token, () => removePasskeyAction({ passkeyId, assertion: wrongIntent })).catch(message)).toMatchInlineSnapshot(`"This passkey confirmation was made for a different action."`)

    const removeAssertion = await confirm(user.token, second.authenticator, { kind: 'remove-passkey', passkeyId })
    await act(user.token, () => removePasskeyAction({ passkeyId, assertion: removeAssertion }))
    expect(await db.query.passkey.findMany({ where: { userId: user.userId } })).toHaveLength(1)

    // Replay of a used assertion.
    expect(await act(user.token, () => removePasskeyAction({ passkeyId: second.passkeyId, assertion: removeAssertion })).catch(message)).toMatchInlineSnapshot(`"Passkey prompt expired. Try again."`)
  })
})

describe('read approvals', () => {
  test('protected environment: blocked reads batch into one request, approval unlocks only that credential, idle and revoked grants end', async () => {
    const user = await createUser()
    const cliToken = await createCliSession(user.token)
    const { orgId, projectId, envId } = await createProject(user.token, {
      prod: { DATABASE_URL: 'postgres://prod', STRIPE_KEY: 'sk_live' },
      preview: { STRIPE_KEY: 'sk_test', PUBLIC_URL: 'https://preview' },
    })
    const userKey = await enroll(user.token)
    const { authenticator } = userKey
    await bootstrap(user.token, userKey, orgId)
    const download = (token: string, env: string) => read(token, `/api/v0/projects/${projectId}/environments/${env}/secrets/download`)
    const getSecret = (token: string, env: string, name: string) => read(token, `/api/v0/projects/${projectId}/environments/${env}/secrets/${name}`)

    // Nothing is protected by default.
    expect((await download(cliToken, 'prod')).status).toBe(200)

    await act(user.token, () => setReadApprovalAction({ environmentId: envId('prod'), readApproval: 'all' }))
    await act(user.token, () => setReadApprovalAction({ environmentId: envId('preview'), readApproval: 'selected' }))
    await act(user.token, () => addSecretApprovalAction({ environmentId: envId('preview'), name: 'STRIPE_KEY' }))

    const blocked = await download(cliToken, 'prod')
    expect(blocked.status).toBe(403)
    expect({ ...blocked.body, approvalId: 'ID', approvalUrl: blocked.body.approvalUrl.replace(blocked.body.approvalId, 'ID'), error: blocked.body.error.replace(blocked.body.approvalId, 'ID') }).toMatchInlineSnapshot(`
      {
        "approvalId": "ID",
        "approvalUrl": "http://e.ly/approve/ID",
        "code": "approval_required",
        "error": "approval required. Open http://e.ly/approve/ID and approve with your passkey, then run the command again",
      }
    `)

    // Per-secret protection: the open secret reads, the protected one joins the same request.
    expect((await getSecret(cliToken, 'preview', 'PUBLIC_URL')).body.value).toBe('https://preview')
    const blockedSecret = await getSecret(cliToken, 'preview', 'STRIPE_KEY')
    expect(blockedSecret.status).toBe(403)
    expect(blockedSecret.body.approvalId).toBe(blocked.body.approvalId)

    // The agent edits the same request: label, plus an item that is already there.
    const requestId = blocked.body.approvalId as string
    const edited = await api(cliToken)('/api/v0/approvals', {
      method: 'POST',
      body: { label: 'Deploy website', items: [{ projectId, environment: 'preview' }] },
    })
    expect(edited).toMatchObject({ id: requestId, status: 'pending' })
    const request = await pendingRequest(requestId)
    expect({ label: request.label, items: request.items.map((item) => `${item.environmentId === envId('prod') ? 'prod' : 'preview'}:${item.secretName || '*'}`).sort() }).toMatchInlineSnapshot(`
      {
        "items": [
          "preview:STRIPE_KEY",
          "prod:*",
        ],
        "label": "Deploy website",
      }
    `)

    const itemIds = request.items.map((item) => item.id)

    // Names and writes stay open while locked.
    const names = await api(cliToken)('/api/v0/projects/:projectId/environments/:environmentId/secrets', { params: { projectId, environmentId: 'prod' } })
    expect(names instanceof Error ? names : names.secrets.map((s) => s.name).sort()).toEqual(['DATABASE_URL', 'STRIPE_KEY'])

    const approve = (assertion: Awaited<ReturnType<Authenticator['assert']>>, seenItemIds = itemIds) =>
      act(user.token, () => approveRequestAction({ requestId, itemIds, seenItemIds, keep: false, assertion }))

    // The Approvals tab lists the pending request for its owner.
    const approvalsTab = async (token: string) => {
      const res = await api(token)('/dash/projects/:projectId/approvals', { params: { projectId } })
      if (res instanceof Error) throw res
      return res.loaderData.requests.map((r: { status: string; label: string; items: { allowed: boolean }[] }) =>
        `${r.status}:${r.label}:${r.items.every((item) => item.allowed) ? 'approvable' : 'needs review'}`)
    }
    expect(await approvalsTab(user.token)).toEqual(['pending:Deploy website:approvable'])

    // Another admin of the same org, with a trusted passkey, cannot see or approve someone else's session request.
    const other = await addMember(orgId, 'admin')
    const otherKey = await enroll(other.token)
    await trust(user.token, userKey, orgId, otherKey.passkeyId)
    expect(await approvalsTab(other.token)).toEqual([])
    expect(await act(other.token, async () => approveRequestAction({
      requestId, itemIds, seenItemIds: itemIds, keep: false,
      assertion: await confirm(other.token, otherKey.authenticator, { kind: 'approve', requestId, itemIds, keep: false }),
    })).catch(message)).toMatchInlineSnapshot(`"You cannot approve this request."`)

    // An approval the human did not see in full is refused.
    expect(await approve(await confirm(user.token, authenticator, { kind: 'approve', requestId, itemIds, keep: false }), itemIds.slice(1)).catch(message)).toMatchInlineSnapshot(`"This request changed. Review it again."`)
    // An assertion for a different item set does not approve this one.
    expect(await approve(await confirm(user.token, authenticator, { kind: 'approve', requestId, itemIds: itemIds.slice(1), keep: false })).catch(message)).toMatchInlineSnapshot(`"This passkey confirmation was made for a different action."`)

    await approve(await confirm(user.token, authenticator, { kind: 'approve', requestId, itemIds, keep: false }))
    expect(await api(cliToken)('/api/v0/approvals/:id', { params: { id: requestId } })).toMatchObject({ id: requestId, status: 'approved' })

    expect((await download(cliToken, 'prod')).body).toEqual({ DATABASE_URL: 'postgres://prod', STRIPE_KEY: 'sk_live' })
    expect((await getSecret(cliToken, 'preview', 'STRIPE_KEY')).body.value).toBe('sk_test')

    // The grant belongs to the CLI session only: not the browser session, not a token.
    expect((await download(user.token, 'prod')).status).toBe(403)
    const { key, hashedKey, prefix } = await generateApiToken()
    const db = getDb()
    await db.insert(schema.apiToken).values({ name: 'ci-deploy', projectId, prefix, hashedKey, createdBy: user.userId })
    const tokenBlocked = await download(key, 'prod')
    expect(tokenBlocked.status).toBe(403)
    expect(tokenBlocked.body.approvalId).not.toBe(requestId)
    // Another credential cannot poll someone else's request.
    expect((await read(key, `/api/v0/approvals/${requestId}`)).status).toBe(404)

    // API tokens can be approved until revoked.
    const tokenRequest = await pendingRequest(tokenBlocked.body.approvalId)
    const tokenItems = tokenRequest.items.map((item) => item.id)
    const keepAssertion = await confirm(user.token, authenticator, { kind: 'approve', requestId: tokenRequest.id, itemIds: tokenItems, keep: true })
    await act(user.token, () => approveRequestAction({ requestId: tokenRequest.id, itemIds: tokenItems, seenItemIds: tokenItems, keep: true, assertion: keepAssertion }))
    expect((await download(key, 'prod')).status).toBe(200)

    // Idle for over an hour: the CLI grant ends, the token grant stays.
    const longAgo = Date.now() - 61 * 60 * 1000
    await db.update(schema.approvalRequest).set({ lastUsedAt: longAgo }).where(orm.inArray(schema.approvalRequest.id, [requestId, tokenRequest.id]))
    expect((await download(cliToken, 'prod')).status).toBe(403)
    expect((await download(key, 'prod')).status).toBe(200)

    // A read marks the grant as used again.
    await db.update(schema.approvalRequest).set({ lastUsedAt: Date.now() - 10 * 60 * 1000 }).where(orm.eq(schema.approvalRequest.id, tokenRequest.id))
    await download(key, 'prod')
    const touched = await db.query.approvalRequest.findFirst({ where: { id: tokenRequest.id } })
    expect(Date.now() - touched!.lastUsedAt!).toBeLessThan(60_000)

    await act(user.token, () => revokeRequestAction({ requestId: tokenRequest.id }))
    expect((await download(key, 'prod')).status).toBe(403)
  })

  test('the website asks too: loaders hide protected values, unlock lasts one minute, protection cannot be lowered or bypassed without a passkey', async () => {
    const user = await createUser()
    const { orgId, projectId, envId } = await createProject(user.token, {
      prod: { STRIPE_KEY: 'sk_live', PUBLIC_URL: 'https://prod' },
      dev: {},
    })
    const userKey = await enroll(user.token)
    const { authenticator } = userKey
    await bootstrap(user.token, userKey, orgId)
    await act(user.token, () => setReadApprovalAction({ environmentId: envId('prod'), readApproval: 'selected' }))
    await act(user.token, () => addSecretApprovalAction({ environmentId: envId('prod'), name: 'STRIPE_KEY' }))

    const f = api(user.token)
    const secretsPage = async () => {
      const res = await f('/dash/projects/:projectId/envs/:envSlug', { params: { projectId, envSlug: 'prod' } })
      if (res instanceof Error) throw res
      return res.loaderData.secrets.map((s: { name: string; value: string | null; locked: boolean }) => ({ name: s.name, value: s.value, locked: s.locked }))
    }
    const eventLog = async () => {
      const res = await f('/dash/projects/:projectId/envs/:envSlug/event-log', { params: { projectId, envSlug: 'prod' } })
      if (res instanceof Error) throw res
      return res.loaderData.events.map((e: { name: string; value: string | null; locked: boolean }) => ({ name: e.name, value: e.value, locked: e.locked }))
    }
    expect(await secretsPage()).toMatchInlineSnapshot(`
      [
        {
          "locked": false,
          "name": "PUBLIC_URL",
          "value": "https://prod",
        },
        {
          "locked": true,
          "name": "STRIPE_KEY",
          "value": null,
        },
      ]
    `)
    expect(await eventLog()).toMatchInlineSnapshot(`
      [
        {
          "locked": true,
          "name": "PUBLIC_URL",
          "value": null,
        },
        {
          "locked": true,
          "name": "STRIPE_KEY",
          "value": null,
        },
      ]
    `)

    // Copying a protected secret into an open environment is a read.
    const sync = () => act(user.token, () => syncMissingSecretsAction({
      sourceEnvironmentId: envId('prod'), targetEnvironmentId: envId('dev'), names: ['STRIPE_KEY', 'PUBLIC_URL'],
    }))
    expect(await sync()).toEqual({ count: 0, needsUnlock: true })

    // Lowering protection needs the passkey. Raising it did not.
    expect(await act(user.token, async () => removeSecretApprovalAction({
      environmentId: envId('prod'), name: 'STRIPE_KEY', assertion: await confirm(user.token, authenticator, { kind: 'unlock', environmentId: envId('prod') }),
    })).catch(message)).toMatchInlineSnapshot(`"This passkey confirmation was made for a different action."`)
    expect(await act(user.token, () => setReadApprovalAction({ environmentId: envId('prod'), readApproval: 'off' })).catch(message)).toMatchInlineSnapshot(`"Passkey confirmation required"`)

    const unlocked = await act(user.token, async () => unlockEnvironmentAction({
      environmentId: envId('prod'), assertion: await confirm(user.token, authenticator, { kind: 'unlock', environmentId: envId('prod') }),
    }))
    expect(unlocked).toEqual({ secrets: [{ name: 'STRIPE_KEY', value: 'sk_live' }] })
    expect(await secretsPage()).toMatchInlineSnapshot(`
      [
        {
          "locked": false,
          "name": "PUBLIC_URL",
          "value": "https://prod",
        },
        {
          "locked": false,
          "name": "STRIPE_KEY",
          "value": "sk_live",
        },
      ]
    `)
    expect(await sync()).toEqual({ count: 2, needsUnlock: false })

    // One minute later the unlock is gone.
    await getDb().update(schema.approvalRequest)
      .set({ grantExpiresAt: Date.now() - 1 })
      .where(orm.isNotNull(schema.approvalRequest.grantExpiresAt))
    expect((await secretsPage()).find((s: { name: string }) => s.name === 'STRIPE_KEY')).toEqual({ name: 'STRIPE_KEY', value: null, locked: true })
  })
})

describe('org passkey trust', () => {
  test('registration grants nothing: setup is explicit and once, rogue keys cannot approve, lower protection or trust, a trusted admin trusts exact candidates', async () => {
    const admin = await createUser()
    const adminCli = await createCliSession(admin.token)
    const { orgId, projectId, envId } = await createProject(admin.token, { prod: { STRIPE_KEY: 'sk_live' } })
    const db = getDb()
    const download = (token: string) => read(token, `/api/v0/projects/${projectId}/environments/prod/secrets/download`)
    const prompt = (token: string, intent: PasskeyIntent) => act(token, () => startPasskeyAssertionAction({ intent })).then(() => 'ok', message)

    // Before setup, invites need no passkey and domain auto-join may be on.
    await act(admin.token, () => createInviteAction({ orgId }))
    await db.update(schema.org).set({ autoJoinDomain: 'acme.com' }).where(orm.eq(schema.org.id, orgId))

    const human = await enroll(admin.token, 'Human')
    // An agent driving the logged-in browser registers its own software key.
    const rogue = await enroll(admin.token, 'Rogue')
    const member = await addMember(orgId)
    const memberKey = await enroll(member.token, 'Member')

    // Registered keys are not enough to protect anything.
    expect(await act(admin.token, () => setReadApprovalAction({ environmentId: envId('prod'), readApproval: 'all' })).catch(message)).toMatchInlineSnapshot(`"Set up a trusted passkey for this organization in Settings first."`)
    expect(await orgPasskeys(admin.token, orgId)).toMatchInlineSnapshot(`
      {
        "canBootstrap": true,
        "initialized": false,
        "passkeys": [
          "Human:untrusted",
          "Rogue:untrusted",
          "Member:untrusted",
        ],
      }
    `)

    // Setup: from a browser, by an admin, signed by the candidate itself.
    expect(await prompt(adminCli, { kind: 'bootstrap-passkey', orgId, passkeyId: human.passkeyId })).toMatchInlineSnapshot(`"Set up the first trusted passkey from the dashboard in a browser, not from a CLI session."`)
    expect(await prompt(member.token, { kind: 'bootstrap-passkey', orgId, passkeyId: memberKey.passkeyId })).toMatchInlineSnapshot(`"Only admins can set up trusted passkeys."`)
    const signedByRogue = await confirm(admin.token, rogue.authenticator, { kind: 'bootstrap-passkey', orgId, passkeyId: human.passkeyId })
    expect(await act(admin.token, () => bootstrapOrgPasskeyAction({ orgId, passkeyId: human.passkeyId, assertion: signedByRogue })).catch(message)).toMatchInlineSnapshot(`"Confirm with the passkey you are trusting."`)

    await bootstrap(admin.token, human, orgId)
    const org = await db.query.org.findFirst({ where: { id: orgId }, with: { invitations: true } })
    expect({ initialized: !!org!.trustInitializedAt, autoJoinDomain: org!.autoJoinDomain, invitations: org!.invitations.length }).toMatchInlineSnapshot(`
      {
        "autoJoinDomain": null,
        "initialized": true,
        "invitations": 0,
      }
    `)
    // Setup happens once.
    expect(await bootstrap(admin.token, rogue, orgId).catch(message)).toMatchInlineSnapshot(`"Passkey setup for this organization is done. An admin with a trusted passkey must trust yours."`)

    await act(admin.token, () => setReadApprovalAction({ environmentId: envId('prod'), readApproval: 'all' }))

    // The rogue key signs the prompts meant for the human key: every org action refuses it.
    const blocked = await download(adminCli)
    const requestId = blocked.body.approvalId as string
    const itemIds = (await pendingRequest(requestId)).items.map((item) => item.id)
    const approveIntent: PasskeyIntent = { kind: 'approve', requestId, itemIds, keep: false }
    expect(await act(admin.token, async () => approveRequestAction({
      requestId, itemIds, seenItemIds: itemIds, keep: false, assertion: await confirm(admin.token, rogue.authenticator, approveIntent),
    })).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    const lowerIntent: PasskeyIntent = { kind: 'set-read-approval', environmentId: envId('prod'), readApproval: 'off' }
    expect(await act(admin.token, async () => setReadApprovalAction({
      environmentId: envId('prod'), readApproval: 'off', assertion: await confirm(admin.token, rogue.authenticator, lowerIntent),
    })).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    expect(await act(admin.token, async () => unlockEnvironmentAction({
      environmentId: envId('prod'), assertion: await confirm(admin.token, rogue.authenticator, { kind: 'unlock', environmentId: envId('prod') }),
    })).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    expect(await trust(admin.token, rogue, orgId, rogue.passkeyId).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    expect((await download(adminCli)).status).toBe(403)

    // The human approves with the trusted key.
    await act(admin.token, async () => approveRequestAction({
      requestId, itemIds, seenItemIds: itemIds, keep: false, assertion: await confirm(admin.token, human.authenticator, approveIntent),
    }))
    expect((await download(adminCli)).status).toBe(200)

    // An untrusted member key cannot even open the prompt for its own request.
    const memberCli = await createCliSession(member.token)
    const memberBlocked = await download(memberCli)
    const memberRequestId = memberBlocked.body.approvalId as string
    const memberItems = (await pendingRequest(memberRequestId)).items.map((item) => item.id)
    const memberIntent: PasskeyIntent = { kind: 'approve', requestId: memberRequestId, itemIds: memberItems, keep: false }
    expect(await prompt(member.token, memberIntent)).toMatchInlineSnapshot(`"None of your passkeys is trusted in this organization. Ask an admin to trust one in Settings."`)

    // Trust names one exact candidate: an assertion for the member key cannot trust the rogue key.
    const forMember = await confirm(admin.token, human.authenticator, { kind: 'trust-passkey', orgId, passkeyId: memberKey.passkeyId })
    expect(await act(admin.token, () => trustOrgPasskeyAction({ orgId, passkeyId: rogue.passkeyId, assertion: forMember })).catch(message)).toMatchInlineSnapshot(`"This passkey confirmation was made for a different action."`)
    await trust(admin.token, human, orgId, memberKey.passkeyId)

    // A trusted member approves their own agent, but cannot trust keys.
    await act(member.token, async () => approveRequestAction({
      requestId: memberRequestId, itemIds: memberItems, seenItemIds: memberItems, keep: false,
      assertion: await confirm(member.token, memberKey.authenticator, memberIntent),
    }))
    expect((await download(memberCli)).status).toBe(200)
    expect(await trust(member.token, memberKey, orgId, memberKey.passkeyId).catch(message)).toMatchInlineSnapshot(`"Only admins can trust passkeys."`)

    // Admins see every member's keys, members only their own.
    expect(await orgPasskeys(admin.token, orgId)).toMatchInlineSnapshot(`
      {
        "canBootstrap": false,
        "initialized": true,
        "passkeys": [
          "Human:trusted",
          "Rogue:untrusted",
          "Member:trusted",
        ],
      }
    `)
    expect(await orgPasskeys(member.token, orgId)).toMatchInlineSnapshot(`
      {
        "canBootstrap": false,
        "initialized": true,
        "passkeys": [
          "Member:trusted",
        ],
      }
    `)

    // The last trusted admin key cannot be removed. With a second one, the rogue key still cannot remove it.
    const removeHuman = (signer: Key) => act(admin.token, async () => removePasskeyAction({
      passkeyId: human.passkeyId,
      assertion: await confirm(admin.token, signer.authenticator, { kind: 'remove-passkey', passkeyId: human.passkeyId }),
    }))
    expect(await removeHuman(human).catch(message)).toMatchInlineSnapshot(`"This is the last trusted admin passkey of an organization. Trust another admin passkey there first."`)
    const backup = await enroll(admin.token, 'Backup')
    await trust(admin.token, human, orgId, backup.passkeyId)
    expect(await removeHuman(rogue).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    await removeHuman(backup)
    expect(await orgPasskeys(admin.token, orgId)).toMatchInlineSnapshot(`
      {
        "canBootstrap": false,
        "initialized": true,
        "passkeys": [
          "Rogue:untrusted",
          "Member:trusted",
          "Backup:trusted",
        ],
      }
    `)
    await act(admin.token, () => removeOrgMemberAction({ memberId: member.memberId }))
    await db.insert(schema.orgMember).values({ orgId, userId: member.userId, role: 'member' })
    expect(await db.query.orgPasskey.findFirst({ where: { orgId, passkeyId: memberKey.passkeyId } })).toBeUndefined()
    expect(await prompt(member.token, { kind: 'unlock', environmentId: envId('prod') })).toMatchInlineSnapshot(`"None of your passkeys is trusted in this organization. Ask an admin to trust one in Settings."`)
    expect((await db.query.org.findFirst({ where: { id: orgId } }))!.trustInitializedAt).not.toBeNull()
  })

  test('an approval needs a key trusted by every org it touches, checked again when the approval is saved', async () => {
    const user = await createUser()
    const cli = await createCliSession(user.token)
    const a = await createProject(user.token, { prod: { A: '1' } })
    const b = await createProject(user.token, { prod: { B: '2' } })
    const keyA = await enroll(user.token, 'Key A')
    const keyB = await enroll(user.token, 'Key B')
    await bootstrap(user.token, keyA, a.orgId)
    await bootstrap(user.token, keyB, b.orgId)
    await act(user.token, () => setReadApprovalAction({ environmentId: a.envId('prod'), readApproval: 'all' }))
    await act(user.token, () => setReadApprovalAction({ environmentId: b.envId('prod'), readApproval: 'all' }))

    const requestId = (await read(cli, `/api/v0/projects/${a.projectId}/environments/prod/secrets/download`)).body.approvalId as string
    expect((await read(cli, `/api/v0/projects/${b.projectId}/environments/prod/secrets/download`)).body.approvalId).toBe(requestId)
    const itemIds = (await pendingRequest(requestId)).items.map((item) => item.id)
    const intent: PasskeyIntent = { kind: 'approve', requestId, itemIds, keep: false }

    // No key is trusted by both orgs.
    expect(await act(user.token, () => startPasskeyAssertionAction({ intent })).catch(message)).toMatchInlineSnapshot(`"None of your passkeys is trusted in this organization. Ask an admin to trust one in Settings."`)

    // Key A becomes trusted in B, opens the prompt, then loses that trust before the approval is saved.
    await trust(user.token, keyB, b.orgId, keyA.passkeyId)
    const assertion = await confirm(user.token, keyA.authenticator, intent)
    await getDb().delete(schema.orgPasskey).where(orm.and(orm.eq(schema.orgPasskey.orgId, b.orgId), orm.eq(schema.orgPasskey.passkeyId, keyA.passkeyId)))
    expect(await act(user.token, () => approveRequestAction({ requestId, itemIds, seenItemIds: itemIds, keep: false, assertion })).catch(message)).toMatchInlineSnapshot(`"This passkey is not trusted in this organization. Ask an admin to trust it in Settings."`)
    const pending = await pendingRequest(requestId)
    expect(pending.status).toBe('pending')

    // The approve page tells which keys the org of each item trusts, so it only
    // offers a selection that one key can sign.
    const page = await api(user.token)('/approve/:id', { params: { id: requestId } })
    if (page instanceof Error) throw page
    const keyNames = new Map([[keyA.passkeyId, 'Key A'], [keyB.passkeyId, 'Key B']])
    expect(page.loaderData.request?.items.map((item: { projectId: string; allowed: boolean; trustedKeyIds: string[] }) =>
      `${item.projectId === a.projectId ? 'a' : 'b'}:${item.allowed}:${item.trustedKeyIds.map((id) => keyNames.get(id))}`).sort()).toEqual(['a:true:Key A', 'b:true:Key B'])

    // Key A approves the part in the org that trusts it. The rest is dropped.
    const itemA = pending.items.find((item) => item.environmentId === a.envId('prod'))!.id
    await act(user.token, async () => approveRequestAction({
      requestId, itemIds: [itemA], seenItemIds: itemIds, keep: false,
      assertion: await confirm(user.token, keyA.authenticator, { kind: 'approve', requestId, itemIds: [itemA], keep: false }),
    }))
    expect((await read(cli, `/api/v0/projects/${a.projectId}/environments/prod/secrets/download`)).status).toBe(200)
    expect((await read(cli, `/api/v0/projects/${b.projectId}/environments/prod/secrets/download`)).status).toBe(403)
  })

  test('after setup every access change needs a trusted passkey signed for its exact payload', async () => {
    const admin = await createUser()
    const { orgId, projectId, envId } = await createProject(admin.token, { prod: {} })
    const db = getDb()
    const member = await addMember(orgId)
    const human = await enroll(admin.token, 'Human')
    const rogue = await enroll(admin.token, 'Rogue')

    // Before setup nothing is gated.
    expect(await act(admin.token, () => createInviteAction({ orgId }))).toMatchObject({ id: expect.any(String) })
    await bootstrap(admin.token, human, orgId)

    await db.update(schema.user).set({ emailVerified: true }).where(orm.eq(schema.user.id, admin.userId)).limit(1)
    await db.update(schema.orgMember).set({ projectAccess: 'selected' }).where(orm.eq(schema.orgMember.id, member.memberId))
    await db.update(schema.environment).set({ accessRole: 'admin' }).where(orm.eq(schema.environment.id, envId('prod')))
    // Each change: the intent the server expects, the same kind signed for other values, the action.
    // Order matters: promotion last, member access refuses admins.
    const changes: Array<[string, PasskeyIntent, PasskeyIntent, (assertion?: Awaited<ReturnType<Authenticator['assert']>>) => Promise<unknown>]> = [
      ['invite', { kind: 'create-invite', orgId, projectIds: null }, { kind: 'create-invite', orgId, projectIds: [projectId] },
        (assertion) => createInviteAction({ orgId, assertion })],
      ['auto-join', { kind: 'enable-auto-join', orgId, autoJoinDomain: 'example.com' }, { kind: 'enable-auto-join', orgId, autoJoinDomain: 'other.com' },
        (assertion) => updateAutoJoinDomainAction({ orgId, enabled: true, assertion })],
      ['member access', { kind: 'update-member-access', orgId, memberId: member.memberId, projectIds: [projectId] }, { kind: 'update-member-access', orgId, memberId: member.memberId, projectIds: [] },
        (assertion) => updateMemberAccessAction({ memberId: member.memberId, projectIds: [projectId], assertion })],
      ['environment role', { kind: 'set-environment-access-role', orgId, environmentId: envId('prod'), accessRole: 'member' }, { kind: 'set-environment-access-role', orgId, environmentId: envId('prod'), accessRole: 'admin' },
        (assertion) => updateEnvironmentAccessRoleAction({ environmentId: envId('prod'), accessRole: 'member', assertion })],
      ['promote', { kind: 'promote-admin', orgId, memberId: member.memberId }, { kind: 'promote-admin', orgId, memberId: admin.userId },
        (assertion) => updateOrgMemberRoleAction({ memberId: member.memberId, role: 'admin', assertion })],
    ]
    const results: Record<string, string[]> = {}
    for (const [name, intent, otherValues, run] of changes) {
      const attempts = [
        () => act(admin.token, () => run()),
        async () => act(admin.token, async () => run(await confirm(admin.token, rogue.authenticator, intent))),
        async () => act(admin.token, async () => run(await confirm(admin.token, human.authenticator, otherValues))),
        async () => act(admin.token, async () => run(await confirm(admin.token, human.authenticator, intent))),
      ]
      results[name] = []
      for (const attempt of attempts) results[name]!.push(await attempt().then(() => 'ok', message))
    }
    expect(results).toMatchInlineSnapshot(`
      {
        "auto-join": [
          "Passkey confirmation required",
          "This passkey is not trusted in this organization. Ask an admin to trust it in Settings.",
          "This passkey confirmation was made for a different action.",
          "ok",
        ],
        "environment role": [
          "Passkey confirmation required",
          "This passkey is not trusted in this organization. Ask an admin to trust it in Settings.",
          "This passkey confirmation was made for a different action.",
          "ok",
        ],
        "invite": [
          "Passkey confirmation required",
          "This passkey is not trusted in this organization. Ask an admin to trust it in Settings.",
          "This passkey confirmation was made for a different action.",
          "ok",
        ],
        "member access": [
          "Passkey confirmation required",
          "This passkey is not trusted in this organization. Ask an admin to trust it in Settings.",
          "This passkey confirmation was made for a different action.",
          "ok",
        ],
        "promote": [
          "Passkey confirmation required",
          "This passkey is not trusted in this organization. Ask an admin to trust it in Settings.",
          "This passkey confirmation was made for a different action.",
          "ok",
        ],
      }
    `)
  })

  test('the last trusted admin cannot be removed or demoted, a refused removal keeps its trust, concurrent changes keep one', async () => {
    const admin = await createUser()
    const { orgId } = await createProject(admin.token, { prod: {} })
    const db = getDb()
    const human = await enroll(admin.token, 'Human')
    await bootstrap(admin.token, human, orgId)
    const adminMemberId = (await db.query.orgMember.findFirst({ where: { orgId, userId: admin.userId } }))!.id
    const second = await addMember(orgId, 'admin')
    const secondKey = await enroll(second.token, 'Second')
    const untrusted = await addMember(orgId, 'admin')
    const names = new Map([[human.passkeyId, 'Human'], [secondKey.passkeyId, 'Second']])
    const trustRows = async () => (await db.query.orgPasskey.findMany({ where: { orgId } })).map((row) => names.get(row.passkeyId) ?? row.passkeyId).sort()
    const run = <T,>(token: string, fn: () => Promise<T>) => act(token, fn).then(() => 'ok', message)
    const remove = (token: string, memberId: string) => run(token, () => removeOrgMemberAction({ memberId }))
    const demote = (token: string, memberId: string) => run(token, () => updateOrgMemberRoleAction({ memberId, role: 'member' }))

    // Other admins exist, but only this one holds a trusted passkey.
    expect([
      await remove(admin.token, adminMemberId),
      await remove(second.token, adminMemberId),
      await demote(second.token, adminMemberId),
    ]).toMatchInlineSnapshot(`
      [
        "This admin holds the last trusted admin passkey of this organization. Trust another admin passkey first.",
        "This admin holds the last trusted admin passkey of this organization. Trust another admin passkey first.",
        "This admin holds the last trusted admin passkey of this organization. Trust another admin passkey first.",
      ]
    `)
    expect(await trustRows()).toEqual(['Human'])
    expect((await db.query.orgMember.findFirst({ where: { id: adminMemberId } }))?.role).toBe('admin')

    // An admin without a trusted passkey can still go.
    expect(await remove(second.token, untrusted.memberId)).toBe('ok')

    // With a spare trusted admin both work. Demotion keeps the trust row, removal deletes it.
    await trust(admin.token, human, orgId, secondKey.passkeyId)
    expect(await demote(second.token, adminMemberId)).toBe('ok')
    expect(await trustRows()).toEqual(['Human', 'Second'])
    expect(await remove(second.token, adminMemberId)).toBe('ok')
    expect(await trustRows()).toEqual(['Second'])

    // Two trusted admins. Each change alone leaves the other one, both pass the
    // pre-checks, so only the check in the write can refuse the second.
    const third = await addMember(orgId, 'admin')
    const thirdKey = await enroll(third.token, 'Third')
    await trust(second.token, secondKey, orgId, thirdKey.passkeyId)
    const actor = await addMember(orgId, 'admin')
    const results = await Promise.all([demote(actor.token, second.memberId), remove(actor.token, third.memberId)])
    expect(results.sort()).toMatchInlineSnapshot(`
      [
        "This admin holds the last trusted admin passkey of this organization. Trust another admin passkey first.",
        "ok",
      ]
    `)
    const rows = await db.query.orgPasskey.findMany({ where: { orgId }, with: { passkey: true } })
    const admins = new Set((await db.query.orgMember.findMany({ where: { orgId, role: 'admin' } })).map((row) => row.userId))
    expect(rows.filter((row) => admins.has(row.passkey!.userId))).toHaveLength(1)
  })

  test('an upgraded org that already protects an environment stays locked: no setup, no approval, no access change', async () => {
    const admin = await createUser()
    const cli = await createCliSession(admin.token)
    const { orgId, projectId, envId } = await createProject(admin.token, { prod: { STRIPE_KEY: 'sk_live' } })
    const key = await enroll(admin.token)
    // What migration 0012 leaves behind for such an org.
    const db = getDb()
    await db.update(schema.environment).set({ readApproval: 'all' }).where(orm.eq(schema.environment.id, envId('prod')))
    await db.update(schema.org).set({ trustInitializedAt: Date.now() }).where(orm.eq(schema.org.id, orgId))

    expect(await orgPasskeys(admin.token, orgId)).toMatchInlineSnapshot(`
      {
        "canBootstrap": false,
        "initialized": true,
        "passkeys": [
          "Test key:untrusted",
        ],
      }
    `)
    expect(await bootstrap(admin.token, key, orgId).catch(message)).toMatchInlineSnapshot(`"Passkey setup for this organization is done. An admin with a trusted passkey must trust yours."`)
    const blocked = await read(cli, `/api/v0/projects/${projectId}/environments/prod/secrets/download`)
    const itemIds = (await pendingRequest(blocked.body.approvalId)).items.map((item) => item.id)
    expect(await act(admin.token, () => startPasskeyAssertionAction({
      intent: { kind: 'approve', requestId: blocked.body.approvalId, itemIds, keep: false },
    })).catch(message)).toMatchInlineSnapshot(`"None of your passkeys is trusted in this organization. Ask an admin to trust one in Settings."`)
    expect(await act(admin.token, () => createInviteAction({ orgId })).catch(message)).toMatchInlineSnapshot(`"Passkey confirmation required"`)

    // Protected but never initialized (not reachable through the app) is refused too.
    await db.update(schema.org).set({ trustInitializedAt: null }).where(orm.eq(schema.org.id, orgId))
    expect(await bootstrap(admin.token, key, orgId).catch(message)).toMatchInlineSnapshot(`"This organization protects environments but trusts no passkey. An operator must trust the first passkey."`)
  })
})
