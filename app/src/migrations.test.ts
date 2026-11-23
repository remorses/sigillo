// Regression tests for D1 data migrations. Real workerd and D1, no mocks.
// The setup file already applied every migration, so each test inserts the
// legacy rows, then replays the real statement from the migration file.

import { describe, test, expect } from 'vitest'
import { env } from 'cloudflare:workers'
import { runAction } from 'spiceflow/testing'
import { ulid } from 'ulid'
import { schema } from 'db'
import { getAuth, getDb, getSession } from './db.js'
import { finishPasskeyRegistrationAction, startPasskeyAssertionAction, startPasskeyRegistrationAction } from './approval-actions.js'

const ORIGIN = 'http://e.ly'

function migrationStatement({ migration, startsWith }: { migration: string; startsWith: string }) {
  const found = env.TEST_MIGRATIONS.find((m) => m.name === migration)
  const statements = found?.queries.filter((query) => query.trim().startsWith(startsWith)) ?? []
  if (statements.length !== 1) throw new Error(`expected one "${startsWith}" statement in ${migration}, got ${statements.length}`)
  return statements[0]!
}

function startRegistration(token: string) {
  const request = new Request(ORIGIN, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  return runAction(() => startPasskeyRegistrationAction({}), { request })
}

describe('0012_org-passkey-trust', () => {
  test('marks every older session as cli, so a legacy device login cannot enroll; a new login is a browser session', async () => {
    const auth = await getAuth(new Request(ORIGIN))
    const email = `migrations-${ulid()}@example.com`
    const password = 'test-password-123'
    const { user } = await auth.api.signUpEmail({ body: { email, name: 'Ada', password } })

    // A device flow session from before 0011: no kind column, so 0011 gave it the default.
    const legacyToken = ulid()
    await env.DB.prepare(
      'INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(ulid(), user.id, legacyToken, Date.now() + 60_000, Date.now(), Date.now(), 'node')
      .run()
    const kinds = async () => (await getDb().query.session.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } })).map((s) => s.kind)
    expect(await kinds()).toMatchInlineSnapshot(`
      [
        "browser",
        "browser",
      ]
    `)

    await env.DB.prepare(migrationStatement({ migration: '0012_org-passkey-trust.sql', startsWith: 'UPDATE `session`' })).run()

    expect(await kinds()).toMatchInlineSnapshot(`
      [
        "cli",
        "cli",
      ]
    `)
    await expect(startRegistration(legacyToken)).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Add passkeys from the dashboard in a browser, not from a CLI session.]`)

    // Signing in again creates a browser session that can enroll.
    const { token } = await auth.api.signInEmail({ body: { email, password } })
    const { options } = await startRegistration(token)
    expect(options.rp.id).toBe('e.ly')
  })

  test('a signed 5 minute cookie cache from before the migration cannot override the cli kind in D1', async () => {
    const auth = await getAuth(new Request(ORIGIN))
    const { user } = await auth.api.signUpEmail({ body: { email: `migrations-${ulid()}@example.com`, name: 'Ada', password: 'test-password-123' } })
    const legacyToken = ulid()
    await env.DB.prepare('INSERT INTO session (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(ulid(), user.id, legacyToken, Date.now() + 60_000, Date.now(), Date.now())
      .run()
    const orgId = ulid()
    const passkeyId = ulid()
    await getDb().batch([
      getDb().insert(schema.org).values({ id: orgId, name: 'Acme' }),
      getDb().insert(schema.orgMember).values({ orgId, userId: user.id, role: 'admin' }),
      getDb().insert(schema.passkey).values({ id: passkeyId, userId: user.id, name: 'Key', credentialId: ulid(), publicKey: 'x', rpId: 'e.ly' }),
    ] as const)

    // Before 0012 the device session is 'browser' in D1. Its holder asks for
    // the session once and keeps the signed session_data cookie, plus a
    // registration challenge.
    const before = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${legacyToken}` }), returnHeaders: true })
    expect(before.response?.session.kind).toBe('browser')
    const sessionData = before.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('better-auth.session_data='))
    if (!sessionData) throw new Error('no session_data cookie')
    const { options } = await startRegistration(legacyToken)

    await env.DB.prepare(migrationStatement({ migration: '0012_org-passkey-trust.sql', startsWith: 'UPDATE `session`' })).run()

    // Within the cache window the cookie still says 'browser'...
    const replay = () => new Request(ORIGIN, { method: 'POST', headers: { authorization: `Bearer ${legacyToken}`, cookie: sessionData } })
    expect((await getSession(replay()))?.kind).toBe('browser')
    // ...but every enrollment and bootstrap gate reads D1.
    const outcome = (promise: Promise<unknown>) => promise.then(() => 'allowed', (error: Error) => error.message)
    expect(await outcome(runAction(() => startPasskeyRegistrationAction({}), { request: replay() }))).toMatchInlineSnapshot(`"Add passkeys from the dashboard in a browser, not from a CLI session."`)
    // The challenge issued before the migration is still unused.
    const clientDataJSON = btoa(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const response = { id: 'cred', rawId: 'cred', type: 'public-key' as const, clientExtensionResults: {}, response: { clientDataJSON, attestationObject: 'x' } }
    expect(await outcome(runAction(() => finishPasskeyRegistrationAction({ response, name: 'Agent key' }), { request: replay() }))).toMatchInlineSnapshot(`"Add passkeys from the dashboard in a browser, not from a CLI session."`)
    expect(await outcome(runAction(() => startPasskeyAssertionAction({ intent: { kind: 'bootstrap-passkey', orgId, passkeyId } }), { request: replay() }))).toMatchInlineSnapshot(`"Set up the first trusted passkey from the dashboard in a browser, not from a CLI session."`)
    expect(await getDb().query.passkey.findMany({ where: { userId: user.id }, columns: { id: true } })).toEqual([{ id: passkeyId }])
  })
})
