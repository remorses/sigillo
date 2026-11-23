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
import { getAuth, getDb, generateApiToken } from './db.js'
import { syncMissingSecretsAction } from './actions.js'
import {
  addSecretApprovalAction,
  approveRequestAction,
  finishPasskeyRegistrationAction,
  removePasskeyAction,
  removeSecretApprovalAction,
  revokeRequestAction,
  setReadApprovalAction,
  startPasskeyAssertionAction,
  startPasskeyRegistrationAction,
  unlockEnvironmentAction,
} from './approval-actions.js'
import type { PasskeyIntent } from './passkey.js'

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

async function enroll(token: string) {
  const authenticator = await createAuthenticator()
  const { options } = await act(token, () => startPasskeyRegistrationAction({}))
  const passkey = await act(token, async () => finishPasskeyRegistrationAction({ response: await authenticator.register(options), name: 'Test key' }))
  return { authenticator, passkeyId: passkey.id }
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
  return { projectId: project.id, envId }
}

async function pendingRequest(requestId: string) {
  const request = await getDb().query.approvalRequest.findFirst({ where: { id: requestId }, with: { items: true } })
  return request!
}

// ── Tests ───────────────────────────────────────────────────────────

describe('passkeys', () => {
  test('first passkey needs a browser session, later ones and removals need a passkey, assertions are single use and bound to one action', async () => {
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
    expect(await act(cliToken, () => startPasskeyRegistrationAction({})).catch(message)).toMatchInlineSnapshot(`"Add your first passkey from the dashboard in a browser, not from a CLI session."`)

    const { authenticator, passkeyId } = await enroll(user.token)

    // A second passkey without an assertion from the first is refused.
    expect(await act(user.token, () => startPasskeyRegistrationAction({})).catch(message)).toMatchInlineSnapshot(`"Passkey confirmation required"`)
    const second = await createAuthenticator()
    const addAssertion = await confirm(user.token, authenticator, { kind: 'add-passkey' })
    const { options } = await act(user.token, () => startPasskeyRegistrationAction({ assertion: addAssertion }))
    await act(user.token, async () => finishPasskeyRegistrationAction({ response: await second.register(options), name: 'Second' }))
    expect(await db.query.passkey.findMany({ where: { userId: user.userId } })).toHaveLength(2)

    // Replay of a used assertion.
    expect(await act(user.token, () => startPasskeyRegistrationAction({ assertion: addAssertion })).catch(message)).toMatchInlineSnapshot(`"Passkey prompt expired. Try again."`)

    // An assertion made for one action does not authorize another.
    const wrongIntent = await confirm(user.token, authenticator, { kind: 'add-passkey' })
    expect(await act(user.token, () => removePasskeyAction({ passkeyId, assertion: wrongIntent })).catch(message)).toMatchInlineSnapshot(`"This passkey confirmation was made for a different action."`)

    const removeAssertion = await confirm(user.token, second, { kind: 'remove-passkey', passkeyId })
    await act(user.token, () => removePasskeyAction({ passkeyId, assertion: removeAssertion }))
    expect(await db.query.passkey.findMany({ where: { userId: user.userId } })).toHaveLength(1)
  })
})

describe('read approvals', () => {
  test('protected environment: blocked reads batch into one request, approval unlocks only that credential, idle and revoked grants end', async () => {
    const user = await createUser()
    const cliToken = await createCliSession(user.token)
    const { projectId, envId } = await createProject(user.token, {
      prod: { DATABASE_URL: 'postgres://prod', STRIPE_KEY: 'sk_live' },
      preview: { STRIPE_KEY: 'sk_test', PUBLIC_URL: 'https://preview' },
    })
    const { authenticator } = await enroll(user.token)
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

    // Another admin of the same org cannot see or approve someone else's session request.
    const other = await createUser()
    const projectRow = await getDb().query.project.findFirst({ where: { id: projectId } })
    await getDb().insert(schema.orgMember).values({ orgId: projectRow!.orgId, userId: other.userId, role: 'admin' })
    const otherKey = await enroll(other.token)
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
    const { projectId, envId } = await createProject(user.token, {
      prod: { STRIPE_KEY: 'sk_live', PUBLIC_URL: 'https://prod' },
      dev: {},
    })
    const { authenticator } = await enroll(user.token)
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
      environmentId: envId('prod'), name: 'STRIPE_KEY', assertion: await confirm(user.token, authenticator, { kind: 'add-passkey' }),
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
