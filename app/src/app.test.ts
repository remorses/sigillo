// Integration tests for the Sigillo app running inside workerd via
// @cloudflare/vitest-pool-workers. Tests run against real D1, real Cache API,
// real AES-256-GCM encryption. No mocks. Test users are created via
// auth.api.signUpEmail (emailAndPassword enabled by VITEST wrangler var).
//
// Uses createSpiceflowFetch(app) for type-safe API testing. Paths and params
// are fully typed — invalid paths or missing params are compile errors.
// Non-2xx responses come back as Error instances; success returns parsed JSON.
//
// createSpiceflowFetch(app) sends requests with host "e.ly" (not localhost),
// so ensureOAuthClient finds the pre-seeded oauth_domain row and returns
// early without calling the provider.

import { describe, test, expect, beforeAll } from 'vitest'
import { createSpiceflowFetch } from 'spiceflow/client'
import { app } from './app.js'
import { getAuth, encrypt, decrypt, deriveSecrets, generateApiToken, getDb } from './db.js'
import { schema } from 'db'

// ── Test helpers ────────────────────────────────────────────────────

let cachedAuth: Awaited<ReturnType<typeof getAuth>> | null = null

async function getTestAuth() {
  if (!cachedAuth) {
    cachedAuth = await getAuth(new Request('http://e.ly'))
  }
  return cachedAuth
}

async function createTestUser(overrides?: { email?: string; name?: string }) {
  const email = overrides?.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const name = overrides?.name ?? 'Test User'
  const auth = await getTestAuth()
  const res = await auth.api.signUpEmail({
    body: { email, name, password: 'test-password-123' },
  })
  return { user: res.user, token: res.token! }
}

/** Throw if Error, return the success result */
function assertOk<T>(result: T | Error): Exclude<T, Error> {
  if (result instanceof Error) throw result
  return result as Exclude<T, Error>
}

/** Assert result is an Error with a specific HTTP status code */
function assertErrorStatus(result: unknown, status: number) {
  expect(result).toBeInstanceOf(Error)
  // spiceflow wraps non-2xx responses as Error with a status property
  expect((result as Error & { status?: number }).status).toBe(status)
}

/** Create a typed fetch client with Bearer auth for a given token */
function authedFetch(token: string) {
  return createSpiceflowFetch(app, {
    headers: { authorization: `Bearer ${token}` },
  })
}

const f = createSpiceflowFetch(app)

// ── Health & Info ───────────────────────────────────────────────────

describe('health & info', () => {
  test('GET /health returns ok', async () => {
    const result = await f('/health');

    expect(result).toMatchInlineSnapshot(`
      {
        "ok": true,
        "service": "sigillo-app",
      }
    `)
  })

  test('GET /api/info returns colo', async () => {
    const result = await f('/api/info')
    expect(result).toMatchInlineSnapshot(`
      {
        "colo": "unknown",
      }
    `)
  })
})

// ── Auth — unauthenticated access ───────────────────────────────────

describe('auth — unauthenticated access', () => {
  test('GET /api/v0/me returns 401', async () => {
    assertErrorStatus(await f('/api/v0/me'), 401)
  })

  test('GET /api/v0/orgs returns 401', async () => {
    assertErrorStatus(await f('/api/v0/orgs'), 401)
  })

  test('POST /api/v0/orgs returns 401', async () => {
    assertErrorStatus(await f('/api/v0/orgs', { method: 'POST', body: { name: 'test' } }), 401)
  })

  test('POST /api/v0/projects returns 401', async () => {
    assertErrorStatus(await f('/api/v0/projects', { method: 'POST', body: { name: 'test', orgId: 'fake' } }), 401)
  })
})

// ── Orgs CRUD ───────────────────────────────────────────────────────

describe('orgs CRUD', () => {
  let af: ReturnType<typeof authedFetch>

  beforeAll(async () => {
    const user = await createTestUser({ name: 'OrgUser' })
    af = authedFetch(user.token)
  })

  test('POST /api/v0/orgs creates an org', async () => {
    const result = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Acme Corp' } }))
    expect(result.ok).toBe(true)
    expect(result.name).toBe('Acme Corp')
    expect(result.id).toBeTruthy()
  })

  test('GET /api/v0/orgs lists user orgs', async () => {
    const result = assertOk(await af('/api/v0/orgs'))
    expect(result.orgs.length).toBeGreaterThanOrEqual(1)
    const org = result.orgs.find((o) => o.name === 'Acme Corp')
    expect(org).toBeTruthy()
    expect(org!.role).toBe('admin')
  })

  test('GET /api/v0/me returns user info with orgs', async () => {
    const result = assertOk(await af('/api/v0/me'))
    expect(result.user.name).toBe('OrgUser')
    expect(result.user.email).toBeTruthy()
    expect(result.orgs.length).toBeGreaterThanOrEqual(1)
  })
})

// ── Projects CRUD ───────────────────────────────────────────────────

describe('projects CRUD', () => {
  let af: ReturnType<typeof authedFetch>
  let orgId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'ProjectUser' })
    af = authedFetch(user.token)
    const result = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Project Org' } }))
    orgId = result.id
  })

  test('POST /api/v0/projects creates project with default environments', async () => {
    const result = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'My App', orgId } }))
    expect(result.ok).toBe(true)
    expect(result.name).toBe('My App')

    // GET the project and verify default environments
    const project = assertOk(await af('/api/v0/projects/:id', { params: { id: result.id } }))
    expect(project.name).toBe('My App')
    expect(project.environments.map((e) => e.slug).sort()).toMatchInlineSnapshot(`
      [
        "dev",
        "preview",
        "prod",
      ]
    `)
  })

  test('GET /api/v0/projects lists projects', async () => {
    const result = assertOk(await af('/api/v0/projects'))
    expect(result.projects.length).toBeGreaterThanOrEqual(1)
    const project = result.projects.find((p) => p.name === 'My App')
    expect(project).toBeTruthy()
    expect(project!.environments.length).toBe(3)
  })

  test('PATCH /api/v0/projects/:id renames project', async () => {
    const created = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'To Rename', orgId } }))
    const patched = assertOk(await af('/api/v0/projects/:id', {
      method: 'PATCH',
      params: { id: created.id },
      body: { name: 'Renamed' },
    }))
    expect(patched.name).toBe('Renamed')
  })

  test('DELETE /api/v0/projects/:id deletes project', async () => {
    const created = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'To Delete', orgId } }))
    assertOk(await af('/api/v0/projects/:id', { method: 'DELETE', params: { id: created.id } }))

    // Verify 404
    const gone = await af('/api/v0/projects/:id', { params: { id: created.id } })
    expect(gone).toBeInstanceOf(Error)
  })
})

// ── Environments CRUD ───────────────────────────────────────────────

describe('environments CRUD', () => {
  let af: ReturnType<typeof authedFetch>
  let projectId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'EnvUser' })
    af = authedFetch(user.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Env Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Env Project', orgId: org.id } }))
    projectId = proj.id
  })

  test('GET lists default environments', async () => {
    const result = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    expect(result.environments.map((e) => ({ name: e.name, slug: e.slug }))).toMatchInlineSnapshot(`
      [
        {
          "name": "Dev",
          "slug": "dev",
        },
        {
          "name": "Preview",
          "slug": "preview",
        },
        {
          "name": "Prod",
          "slug": "prod",
        },
      ]
    `)
  })

  test('POST creates a custom environment', async () => {
    const result = assertOk(await af('/api/v0/projects/:pid/environments', {
      method: 'POST',
      params: { pid: projectId },
      body: { name: 'Staging', slug: 'staging' },
    }))
    expect(result.ok).toBe(true)
    expect(result.name).toBe('Staging')
    expect(result.slug).toBe('staging')
  })

  test('DELETE removes an environment', async () => {
    const created = assertOk(await af('/api/v0/projects/:pid/environments', {
      method: 'POST',
      params: { pid: projectId },
      body: { name: 'Temp', slug: 'temp' },
    }))
    assertOk(await af('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE',
      params: { pid: projectId, id: created.id },
    }))
  })

  test('GET by slug resolves environment', async () => {
    const result = assertOk(await af('/api/v0/projects/:pid/environments/:id', {
      params: { pid: projectId, id: 'dev' },
    }))
    expect(result.slug).toBe('dev')
    expect(result.name).toBe('Dev')
  })
})

// ── Secrets — core flow ─────────────────────────────────────────────

describe('secrets — core flow', () => {
  let af: ReturnType<typeof authedFetch>
  let projectId: string
  let envId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'SecretUser' })
    af = authedFetch(user.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Secret Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Secret Project', orgId: org.id } }))
    projectId = proj.id
    const env = assertOk(await af('/api/v0/projects/:pid/environments/:id', { params: { pid: projectId, id: 'dev' } }))
    envId = env.id
  })

  test('set and get a secret value', async () => {
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: envId },
      body: { name: 'DATABASE_URL', value: 'postgres://localhost:5432/mydb' },
    }))

    const got = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: envId, name: 'DATABASE_URL' },
    }))
    expect(got.name).toBe('DATABASE_URL')
    expect(got.value).toBe('postgres://localhost:5432/mydb')
  })

  test('list secrets does not include values', async () => {
    const result = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: envId },
    }))
    expect(result.secrets.length).toBeGreaterThanOrEqual(1)
    const dbSecret = result.secrets.find((s) => s.name === 'DATABASE_URL')
    expect(dbSecret).toBeTruthy()
    expect(dbSecret!.name).toBe('DATABASE_URL')
    // list endpoint correctly does NOT return the value field
    expect('value' in dbSecret!).toBe(false)
  })

  test('delete secret makes it gone', async () => {
    await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: envId },
      body: { name: 'TO_DELETE', value: 'gone' },
    })

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      method: 'DELETE',
      params: { pid: projectId, eid: envId, name: 'TO_DELETE' },
    }))

    const gone = await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: envId, name: 'TO_DELETE' },
    })
    expect(gone).toBeInstanceOf(Error)
  })

  test('event sourcing: set → update → delete → set yields final value', async () => {
    const p = { pid: projectId, eid: envId }
    const post = (name: string, value: string) =>
      af('/api/v0/projects/:pid/environments/:eid/secrets', { method: 'POST', params: p, body: { name, value } })
    const del = (name: string) =>
      af('/api/v0/projects/:pid/environments/:eid/secrets/:name', { method: 'DELETE', params: { ...p, name } })
    const get = (name: string) =>
      af('/api/v0/projects/:pid/environments/:eid/secrets/:name', { params: { ...p, name } })

    await post('EVOLVING', 'v1')
    await post('EVOLVING', 'v2')
    await del('EVOLVING')
    await post('EVOLVING', 'v3')

    const result = assertOk(await get('EVOLVING'))
    expect(result.value).toBe('v3')
  })

  test('bulk set secrets', async () => {
    const result = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: envId },
      body: { secrets: { BULK_A: 'alpha', BULK_B: 'beta', BULK_C: 'gamma' } },
    }))
    expect(result.ok).toBe(true)
    expect(result.secrets.sort()).toMatchInlineSnapshot(`
      [
        "BULK_A",
        "BULK_B",
        "BULK_C",
      ]
    `)

    for (const [name, value] of [['BULK_A', 'alpha'], ['BULK_B', 'beta'], ['BULK_C', 'gamma']] as const) {
      const s = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
        params: { pid: projectId, eid: envId, name },
      }))
      expect(s.value).toBe(value)
    }
  })
})

// ── Secrets — download formats ──────────────────────────────────────

describe('secrets — download formats', () => {
  let token: string
  let projectId: string
  let envId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'DownloadUser' })
    token = user.token
    const af = authedFetch(token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Download Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Download Project', orgId: org.id } }))
    projectId = proj.id
    const env = assertOk(await af('/api/v0/projects/:pid/environments/:id', { params: { pid: projectId, id: 'dev' } }))
    envId = env.id

    await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: envId },
      body: { secrets: { DB_HOST: 'localhost', DB_PORT: '5432' } },
    })
  })

  // Download routes return raw text/json, so use app.handle() for these
  function downloadUrl(format: string) {
    return `http://e.ly/api/v0/projects/${projectId}/environments/${envId}/secrets/download?format=${format}`
  }
  function downloadReq(format: string) {
    return app.handle(new Request(downloadUrl(format), {
      headers: { authorization: `Bearer ${token}` },
    }))
  }

  test('json format', async () => {
    const res = await downloadReq('json')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "DB_HOST": "localhost",
        "DB_PORT": "5432",
      }
    `)
  })

  test('env format', async () => {
    const res = await downloadReq('env')
    const text = await res.text()
    expect(text).toContain('DB_HOST="localhost"')
    expect(text).toContain('DB_PORT="5432"')
  })

  test('env-no-quotes format', async () => {
    const res = await downloadReq('env-no-quotes')
    const text = await res.text()
    expect(text).toContain('DB_HOST=localhost')
    expect(text).toContain('DB_PORT=5432')
    expect(text).not.toContain('"')
  })

  test('yaml format', async () => {
    const res = await downloadReq('yaml')
    const text = await res.text()
    expect(text).toContain('DB_HOST: "localhost"')
    expect(text).toContain('DB_PORT: "5432"')
  })

  test('dotnet-json format nests keys with __', async () => {
    const af = authedFetch(token)
    await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: envId },
      body: { name: 'CONNECTION__HOST', value: 'Server=localhost' },
    })
    const res = await downloadReq('dotnet-json')
    const body = await res.json() as Record<string, Record<string, string>>
    // toDotnetJsonKey lowercases then PascalCases each segment
    expect(body.Connection).toBeTruthy()
    expect(body.Connection!.Host).toBe('Server=localhost')
  })
})

// ── API tokens ──────────────────────────────────────────────────────

describe('api tokens', () => {
  let userToken: string
  let projectId: string
  let devEnvId: string
  let prodEnvId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'TokenUser' })
    userToken = user.token
    const af = authedFetch(userToken)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Token Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Token Project', orgId: org.id } }))
    projectId = proj.id
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    devEnvId = envs.environments.find((e) => e.slug === 'dev')!.id
    prodEnvId = envs.environments.find((e) => e.slug === 'prod')!.id

    // Seed a secret in dev
    await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: devEnvId },
      body: { name: 'TOKEN_TEST', value: 'secret-value' },
    })
  })

  test('project-scoped token can access secrets', async () => {
    const db = getDb()
    const user = await createTestUser({ name: 'TokenCreator' })
    const { key, hashedKey, prefix } = await generateApiToken()

    await db.insert(schema.apiToken).values({
      name: 'ci-token',
      projectId,
      prefix,
      hashedKey,
      createdBy: user.user.id,
    })

    // Use the API token to access secrets
    const tokenFetch = authedFetch(key)
    const result = assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: devEnvId, name: 'TOKEN_TEST' },
    }))
    expect(result.value).toBe('secret-value')
  })

  test('env-scoped token cannot access other environments', async () => {
    const db = getDb()
    const user = await createTestUser({ name: 'ScopedTokenUser' })
    const { key, hashedKey, prefix } = await generateApiToken()

    await db.insert(schema.apiToken).values({
      name: 'dev-only',
      projectId,
      environmentId: devEnvId,
      prefix,
      hashedKey,
      createdBy: user.user.id,
    })

    const tokenFetch = authedFetch(key)

    // Access dev env — should work
    const devResult = assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))
    expect(devResult.secrets).toBeTruthy()

    // Access prod env — should be forbidden
    const prodResult = await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: prodEnvId },
    })
    assertErrorStatus(prodResult, 403)
  })

  test('invalid token returns 401', async () => {
    const badFetch = authedFetch('sig_invalid_token_that_does_not_exist')
    const result = await badFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    })
    assertErrorStatus(result, 401)
  })
})

// ── Security — cross-user isolation ─────────────────────────────────
// Uses app.handle() directly here to check specific HTTP status codes (403 vs 401)

describe('security — cross-user isolation', () => {
  let userAToken: string
  let userAProjectId: string
  let userAEnvId: string
  let userAOrgId: string
  let userBToken: string

  beforeAll(async () => {
    const userA = await createTestUser({ name: 'Alice', email: 'alice-sec@test.com' })
    userAToken = userA.token
    const userB = await createTestUser({ name: 'Bob', email: 'bob-sec@test.com' })
    userBToken = userB.token

    const af = authedFetch(userAToken)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Alice Org' } }))
    userAOrgId = org.id
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Alice Project', orgId: userAOrgId } }))
    userAProjectId = proj.id
    const env = assertOk(await af('/api/v0/projects/:pid/environments/:id', { params: { pid: userAProjectId, id: 'dev' } }))
    userAEnvId = env.id

    await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: userAProjectId, eid: userAEnvId },
      body: { name: 'ALICE_SECRET', value: 'only-for-alice' },
    })
  })

  function req(path: string, token: string, method = 'GET', body?: Record<string, unknown>) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (body) headers['content-type'] = 'application/json'
    return app.handle(new Request(`http://e.ly${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }))
  }

  test('user B cannot access user A project (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}`, userBToken)
    expect(res.status).toBe(403)
  })

  test('user B cannot list user A secrets (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, userBToken)
    expect(res.status).toBe(403)
  })

  test('user B cannot create project in user A org (403)', async () => {
    const res = await req('/api/v0/projects', userBToken, 'POST', { name: 'Sneaky', orgId: userAOrgId })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A project (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}`, userBToken, 'DELETE')
    expect(res.status).toBe(403)
  })

  test('user B cannot get user A secret value (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets/ALICE_SECRET`, userBToken)
    expect(res.status).toBe(403)
  })

  // Write-path isolation — these are the scary paths
  test('user B cannot set secrets in user A env (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, userBToken, 'POST', {
      name: 'INJECTED', value: 'evil',
    })
    expect(res.status).toBe(403)
  })

  test('user B cannot bulk-set secrets in user A env (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, userBToken, 'PUT', {
      secrets: { INJECTED: 'evil' },
    })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A secret (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets/ALICE_SECRET`, userBToken, 'DELETE')
    expect(res.status).toBe(403)
  })

  test('user B cannot create environment in user A project (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments`, userBToken, 'POST', {
      name: 'Injected', slug: 'injected',
    })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A environment (403)', async () => {
    const res = await req(`/api/v0/projects/${userAProjectId}/environments/${userAEnvId}`, userBToken, 'DELETE')
    expect(res.status).toBe(403)
  })
})

// ── Encryption roundtrip ────────────────────────────────────────────

describe('encryption roundtrip', () => {
  test('encrypt then decrypt returns original', async () => {
    const { encrypted, iv } = await encrypt('hello-world')
    const decrypted = await decrypt(encrypted, iv)
    expect(decrypted).toBe('hello-world')
  })

  test('two encryptions produce different IVs', async () => {
    const a = await encrypt('same-value')
    const b = await encrypt('same-value')
    expect(a.iv).not.toBe(b.iv)
    expect(a.encrypted).not.toBe(b.encrypted)
  })

  test('empty string roundtrip', async () => {
    const { encrypted, iv } = await encrypt('')
    const decrypted = await decrypt(encrypted, iv)
    expect(decrypted).toBe('')
  })

  test('unicode roundtrip', async () => {
    const value = '🔐 Ключ шифрования 密钥'
    const { encrypted, iv } = await encrypt(value)
    const decrypted = await decrypt(encrypted, iv)
    expect(decrypted).toBe(value)
  })
})
