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
import * as orm from 'drizzle-orm'
import { runAction } from 'spiceflow/testing'
import { app } from './app.js'
import { acceptInviteAction } from './actions.js'
import { getAuth, encrypt, decrypt, deriveSecrets, deriveEnvironmentSecretsAndNames, generateApiToken, getDb, autoJoinOrgsByDomain, getMemberProjectAccess, getAccessibleProjectIds } from './db.js'
import { schema } from 'db'
import { makeSignature } from 'better-auth/crypto'
import { formatAbsoluteDate, formatTime } from './lib/utils.js'

// ── Test helpers ────────────────────────────────────────────────────

let cachedAuth: Awaited<ReturnType<typeof getAuth>> | null = null

async function getTestAuth() {
  if (!cachedAuth) {
    cachedAuth = await getAuth(new Request('http://e.ly'))
  }
  return cachedAuth
}

async function insertApiToken({
  name,
  projectId,
  createdBy,
  environmentIds,
}: {
  name: string
  projectId: string
  createdBy: string
  environmentIds?: string[]
}) {
  const { key, hashedKey, prefix } = await generateApiToken()
  const db = getDb()
  const [token] = await db.insert(schema.apiToken).values({
    name,
    projectId,
    prefix,
    hashedKey,
    createdBy,
  }).returning({ id: schema.apiToken.id })
  if (environmentIds?.length) {
    await db.insert(schema.apiTokenEnvironment).values(
      environmentIds.map((environmentId) => ({ tokenId: token!.id, environmentId })),
    )
  }
  return { key, tokenId: token!.id }
}

async function createTestUser(overrides?: { email?: string; name?: string }) {
  const email = overrides?.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`
  const name = overrides?.name ?? 'Test User'
  const auth = await getTestAuth()
  const res = await auth.api.signUpEmail({
    body: { email, name, password: 'test-password-123' },
  })
  // Signed like the session cookie and the CLI's token; bearer() refuses raw tokens
  const { secret } = await auth.$context
  return { user: res.user, token: `${res.token!}.${await makeSignature(res.token!, secret)}` }
}

/** Throw if Error, return the success result */
// TS cannot narrow `T | Error` to `Exclude<T, Error>` on a type parameter,
// so the cast is unavoidable here (canonical errore-style helper).
function assertOk<T>(result: T | Error): Exclude<T, Error> {
  if (result instanceof Error) throw result
  return result as Exclude<T, Error>
}

/** Assert result is an Error with a specific HTTP status code */
function assertErrorStatus<T>(result: T | Error, status: number) {
  expect(result).toBeInstanceOf(Error)
  if (!(result instanceof Error)) throw new Error('unreachable')
  // spiceflow wraps non-2xx responses as Error with a status property
  expect(Reflect.get(result, 'status')).toBe(status)
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
    expect(dbSecret).not.toHaveProperty('value')
  })

  test('delete secret makes it gone', async () => {
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: envId },
      body: { name: 'TO_DELETE', value: 'gone' },
    }))

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
    const post = async (name: string, value: string) =>
      assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', { method: 'POST', params: p, body: { name, value } }))
    const del = async (name: string) =>
      assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', { method: 'DELETE', params: { ...p, name } }))
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

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: envId },
      body: { secrets: { DB_HOST: 'localhost', DB_PORT: '5432' } },
    }))
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
    expect(text).toContain(`DB_HOST='localhost'`)
    expect(text).toContain(`DB_PORT='5432'`)
  })

  // Regression: values were JSON.stringify'd into double quotes, so
  // `source .env` ran $(...) and backticks. Names were unvalidated, so a
  // newline in a name injected extra lines into env/docker/yaml.
  test('env/yaml/docker downloads cannot inject shell commands or lines', async () => {
    const af = authedFetch(token)
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    const previewEnvId = envs.environments.find((e) => e.slug === 'preview')!.id

    const badName = await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: previewEnvId },
      body: { name: 'A\nEVIL', value: 'x' },
    })
    expect(badName).toBeInstanceOf(Error)
    const badBulk = await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: previewEnvId },
      body: { secrets: { 'X=1 Y': 'x' } },
    })
    expect(badBulk).toBeInstanceOf(Error)

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: previewEnvId },
      body: {
        secrets: {
          SUBSHELL: '$(touch /tmp/pwned)',
          BACKTICK: '`id`',
          VAR: '$HOME',
          QUOTE_ONLY: `it's`,
          QUOTE_AND_DOLLAR: `it's $(id)`,
          MULTILINE: 'line1\nline2',
        },
      },
    }))
    // Legacy rows written before validation must still be sanitized on output.
    const db = getDb()
    const legacy = await encrypt('ok')
    const injected = await encrypt('x')
    await db.insert(schema.secretEvent).values([
      { environmentId: previewEnvId, name: 'legacy-name', operation: 'set', valueEncrypted: legacy.encrypted, iv: legacy.iv },
      { environmentId: previewEnvId, name: 'A\nEVIL', operation: 'set', valueEncrypted: injected.encrypted, iv: injected.iv },
    ])

    const download = async (format: string) => {
      const res = await app.handle(new Request(
        `http://e.ly/api/v0/projects/${projectId}/environments/${previewEnvId}/secrets/download?format=${format}`,
        { headers: { authorization: `Bearer ${token}` } },
      ))
      return (await res.text()).split('\n').sort().join('\n')
    }

    expect(await download('env')).toMatchInlineSnapshot(`
      "
      BACKTICK='\`id\`'
      MULTILINE='line1
      QUOTE_AND_DOLLAR='it'\\''s $(id)'
      QUOTE_ONLY="it's"
      SUBSHELL='$(touch /tmp/pwned)'
      VAR='$HOME'
      legacy-name='ok'
      line2'"
    `)
    expect(await download('yaml')).toMatchInlineSnapshot(`
      "
      BACKTICK: "\`id\`"
      MULTILINE: "line1\\nline2"
      QUOTE_AND_DOLLAR: "it's $(id)"
      QUOTE_ONLY: "it's"
      SUBSHELL: "$(touch /tmp/pwned)"
      VAR: "$HOME"
      legacy-name: "ok""
    `)
    expect(await download('docker')).toMatchInlineSnapshot(`
      "
      BACKTICK=\`id\`
      MULTILINE=line1\\nline2
      QUOTE_AND_DOLLAR=it's $(id)
      QUOTE_ONLY=it's
      SUBSHELL=$(touch /tmp/pwned)
      VAR=$HOME
      legacy-name=ok"
    `)

    // Output stays readable by our dotenv parser for dotenv-representable values.
    const { parseEnv } = await import('./lib/parse-env.ts')
    const { renderEnvFile } = await import('./lib/utils.ts')
    const roundTrip = parseEnv(renderEnvFile([
      ['SUBSHELL', '$(touch /tmp/pwned)'],
      ['QUOTE_ONLY', `it's`],
      ['MULTILINE', 'line1\nline2'],
    ]))
    expect(roundTrip).toMatchInlineSnapshot(`
      {
        "MULTILINE": "line1
      line2",
        "QUOTE_ONLY": "it's",
        "SUBSHELL": "$(touch /tmp/pwned)",
      }
    `)
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
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: envId },
      body: { name: 'CONNECTION__HOST', value: 'Server=localhost' },
    }))
    const res = await downloadReq('dotnet-json')
    const body: Record<string, Record<string, string>> = await res.json()
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
  let previewEnvId: string
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
    previewEnvId = envs.environments.find((e) => e.slug === 'preview')!.id
    prodEnvId = envs.environments.find((e) => e.slug === 'prod')!.id

    // Seed a secret in dev
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: devEnvId },
      body: { name: 'TOKEN_TEST', value: 'secret-value' },
    }))
  })

  test('project-scoped token can access secrets', async () => {
    const user = await createTestUser({ name: 'TokenCreator' })
    const { key } = await insertApiToken({
      name: 'ci-token',
      projectId,
      createdBy: user.user.id,
    })

    // Use the API token to access secrets
    const tokenFetch = authedFetch(key)
    const result = assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: devEnvId, name: 'TOKEN_TEST' },
    }))
    expect(result.value).toBe('secret-value')
  })

  // Regression: secret_event.api_token_id was ON DELETE CASCADE, so deleting
  // a token deleted the secrets it wrote and reverted overwritten values.
  test('deleting a token or user keeps the secrets it wrote', async () => {
    const user = await createTestUser({ name: 'TokenDeleteUser' })
    const { key, tokenId } = await insertApiToken({ name: 'writer', projectId, createdBy: user.user.id })
    assertOk(await authedFetch(userToken)('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: devEnvId },
      body: { name: 'TOKEN_OVERWRITE', value: 'written-by-user' },
    }))
    assertOk(await authedFetch(key)('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT',
      params: { pid: projectId, eid: devEnvId },
      body: { secrets: { TOKEN_OVERWRITE: 'overwritten-by-token', TOKEN_ONLY: 'written-by-token' } },
    }))

    // Same for a deleted user (user_id was also ON DELETE CASCADE).
    const author = await createTestUser({ name: 'DeletedAuthor' })
    const enc = await encrypt('written-by-deleted-user')
    await getDb().insert(schema.secretEvent).values({
      environmentId: devEnvId, name: 'USER_ONLY', operation: 'set', valueEncrypted: enc.encrypted, iv: enc.iv, userId: author.user.id,
    })

    await getDb().delete(schema.apiToken).where(orm.eq(schema.apiToken.id, tokenId))
    await getDb().delete(schema.user).where(orm.eq(schema.user.id, author.user.id))

    const derived = await deriveSecrets(devEnvId)
    const values = Object.fromEntries(await Promise.all(
      derived
        .filter((d) => ['TOKEN_OVERWRITE', 'TOKEN_ONLY', 'USER_ONLY'].includes(d.name))
        .map(async (d) => [d.name, await decrypt(d.valueEncrypted!, d.iv!)] as const),
    ))
    expect(values).toMatchInlineSnapshot(`
      {
        "TOKEN_ONLY": "written-by-token",
        "TOKEN_OVERWRITE": "overwritten-by-token",
        "USER_ONLY": "written-by-deleted-user",
      }
    `)
  })

  test('env-scoped token cannot access other environments', async () => {
    const user = await createTestUser({ name: 'ScopedTokenUser' })
    const { key } = await insertApiToken({
      name: 'dev-only',
      projectId,
      createdBy: user.user.id,
      environmentIds: [devEnvId],
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

  test('project-scoped token can get its project (setup path)', async () => {
    const user = await createTestUser({ name: 'SetupTokenUser' })
    const { key } = await insertApiToken({
      name: 'setup-token',
      projectId,
      createdBy: user.user.id,
    })

    const result = assertOk(await authedFetch(key)('/api/v0/projects/:id', {
      params: { id: projectId },
    }))
    expect(result.id).toBe(projectId)
    expect(result.environments.map((e) => e.slug).sort()).toEqual(['dev', 'preview', 'prod'])
  })

  test('project-scoped token can list only its project', async () => {
    const user = await createTestUser({ name: 'ListTokenUser' })
    const { key } = await insertApiToken({
      name: 'list-token',
      projectId,
      createdBy: user.user.id,
    })

    const result = assertOk(await authedFetch(key)('/api/v0/projects'))
    expect(result.projects.map((p) => p.id)).toEqual([projectId])
  })

  test('project-scoped token can list its environments', async () => {
    const user = await createTestUser({ name: 'EnvListTokenUser' })
    const { key } = await insertApiToken({
      name: 'env-list-token',
      projectId,
      createdBy: user.user.id,
    })

    const result = assertOk(await authedFetch(key)('/api/v0/projects/:pid/environments', {
      params: { pid: projectId },
    }))
    expect(result.environments.map((e) => e.slug).sort()).toEqual(['dev', 'preview', 'prod'])
  })

  test('token cannot get a different project', async () => {
    const db = getDb()
    const user = await createTestUser({ name: 'CrossProjectTokenUser' })
    const af = authedFetch(user.token)
    const otherOrg = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Other Org' } }))
    const otherProj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Other Project', orgId: otherOrg.id } }))

    const { key } = await insertApiToken({
      name: 'scoped-token',
      projectId,
      createdBy: user.user.id,
    })

    const result = await authedFetch(key)('/api/v0/projects/:id', {
      params: { id: otherProj.id },
    })
    assertErrorStatus(result, 403)
  })

  test('env-scoped token only sees that environment on the project', async () => {
    const user = await createTestUser({ name: 'EnvScopedSetupUser' })
    const { key } = await insertApiToken({
      name: 'dev-setup',
      projectId,
      createdBy: user.user.id,
      environmentIds: [devEnvId],
    })

    const project = assertOk(await authedFetch(key)('/api/v0/projects/:id', {
      params: { id: projectId },
    }))
    expect(project.environments.map((e) => e.slug)).toEqual(['dev'])

    const envs = assertOk(await authedFetch(key)('/api/v0/projects/:pid/environments', {
      params: { pid: projectId },
    }))
    expect(envs.environments.map((e) => e.slug)).toEqual(['dev'])
  })

  test('token cannot mutate a project', async () => {
    const user = await createTestUser({ name: 'MutateTokenUser' })
    const { key } = await insertApiToken({
      name: 'read-only',
      projectId,
      createdBy: user.user.id,
    })

    const patched = await authedFetch(key)('/api/v0/projects/:id', {
      method: 'PATCH',
      params: { id: projectId },
      body: { name: 'Hacked' },
    })
    assertErrorStatus(patched, 401)
  })

  test('invalid token on project get returns 401', async () => {
    const result = await authedFetch('sig_invalid_token_that_does_not_exist')('/api/v0/projects/:id', {
      params: { id: projectId },
    })
    assertErrorStatus(result, 401)
  })

  test('deleting a scoped environment revokes the token', async () => {
    const user = await createTestUser({ name: 'CascadeTokenUser' })
    const af = authedFetch(user.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Cascade Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Cascade Project', orgId: org.id } }))
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: proj.id } }))
    const dev = envs.environments.find((e) => e.slug === 'dev')!
    const prod = envs.environments.find((e) => e.slug === 'prod')!

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: proj.id, eid: prod.id },
      body: { name: 'PROD_SECRET', value: 'prod-value' },
    }))

    const { key } = await insertApiToken({
      name: 'dev-only',
      projectId: proj.id,
      createdBy: user.user.id,
      environmentIds: [dev.id],
    })

    assertOk(await af('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE',
      params: { pid: proj.id, id: dev.id },
    }))

    const result = await authedFetch(key)('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: proj.id, eid: prod.id, name: 'PROD_SECRET' },
    })
    assertErrorStatus(result, 401)
  })

  test('project-scoped token can call me and list its org', async () => {
    const user = await createTestUser({ name: 'MeTokenUser' })
    const { key } = await insertApiToken({
      name: 'me-token',
      projectId,
      createdBy: user.user.id,
    })

    const tf = authedFetch(key)
    const me = assertOk(await tf('/api/v0/me'))
    expect(me.user.id).toBe(user.user.id)
    expect(me.user.name).toBe('MeTokenUser')
    expect(me.orgs).toHaveLength(1)

    const orgs = assertOk(await tf('/api/v0/orgs'))
    expect(orgs.orgs.map((org) => org.id)).toEqual([me.orgs[0]!.id])
  })

  test('project-scoped token can get an environment', async () => {
    const user = await createTestUser({ name: 'EnvGetTokenUser' })
    const { key } = await insertApiToken({
      name: 'env-get-token',
      projectId,
      createdBy: user.user.id,
    })

    const result = assertOk(await authedFetch(key)('/api/v0/projects/:pid/environments/:id', {
      params: { pid: projectId, id: devEnvId },
    }))
    expect(result.id).toBe(devEnvId)
    expect(result.slug).toBe('dev')
  })

  test('env-scoped token cannot get a different environment', async () => {
    const user = await createTestUser({ name: 'EnvGetScopedUser' })
    const { key } = await insertApiToken({
      name: 'dev-get',
      projectId,
      createdBy: user.user.id,
      environmentIds: [devEnvId],
    })

    const result = await authedFetch(key)('/api/v0/projects/:pid/environments/:id', {
      params: { pid: projectId, id: prodEnvId },
    })
    assertErrorStatus(result, 403)
  })

  test('token scoped to multiple envs can access those envs but not others', async () => {
    const user = await createTestUser({ name: 'MultiEnvTokenUser' })
    const { key } = await insertApiToken({
      name: 'dev-preview',
      projectId,
      createdBy: user.user.id,
      environmentIds: [devEnvId, previewEnvId],
    })

    const tokenFetch = authedFetch(key)
    assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))
    assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: previewEnvId },
    }))
    assertErrorStatus(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: prodEnvId },
    }), 403)

    const project = assertOk(await tokenFetch('/api/v0/projects/:id', {
      params: { id: projectId },
    }))
    expect(project.environments.map((e) => e.slug).sort()).toEqual(['dev', 'preview'])

    const envs = assertOk(await tokenFetch('/api/v0/projects/:pid/environments', {
      params: { pid: projectId },
    }))
    expect(envs.environments.map((e) => e.slug).sort()).toEqual(['dev', 'preview'])
  })

  test('deleting one env from a multi-env token keeps the others', async () => {
    const user = await createTestUser({ name: 'PartialCascadeUser' })
    const af = authedFetch(user.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Partial Cascade Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Partial Cascade Project', orgId: org.id } }))
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: proj.id } }))
    const dev = envs.environments.find((e) => e.slug === 'dev')!
    const preview = envs.environments.find((e) => e.slug === 'preview')!
    const prod = envs.environments.find((e) => e.slug === 'prod')!

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: proj.id, eid: preview.id },
      body: { name: 'PREVIEW_SECRET', value: 'preview-value' },
    }))
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: proj.id, eid: prod.id },
      body: { name: 'PROD_SECRET', value: 'prod-value' },
    }))

    const { key } = await insertApiToken({
      name: 'dev-preview',
      projectId: proj.id,
      createdBy: user.user.id,
      environmentIds: [dev.id, preview.id],
    })

    assertOk(await af('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE',
      params: { pid: proj.id, id: dev.id },
    }))

    const tokenFetch = authedFetch(key)
    const previewSecret = assertOk(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: proj.id, eid: preview.id, name: 'PREVIEW_SECRET' },
    }))
    expect(previewSecret.value).toBe('preview-value')
    assertErrorStatus(await tokenFetch('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: proj.id, eid: prod.id, name: 'PROD_SECRET' },
    }), 403)
  })
})

// ── Security — cross-user isolation ─────────────────────────────────
// Uses app.handle() directly here to check specific HTTP status codes (403 vs 401)

describe('security — cross-user isolation', () => {
  let userAToken: string
  let userAProjectId: string
  let userAEnvId: string
  let userAOrgId: string
  let userAId: string
  let userBToken: string

  beforeAll(async () => {
    const userA = await createTestUser({ name: 'Alice', email: 'alice-sec@test.com' })
    userAToken = userA.token
    userAId = userA.user.id
    const userB = await createTestUser({ name: 'Bob', email: 'bob-sec@test.com' })
    userBToken = userB.token

    const af = authedFetch(userAToken)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Alice Org' } }))
    userAOrgId = org.id
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Alice Project', orgId: userAOrgId } }))
    userAProjectId = proj.id
    const env = assertOk(await af('/api/v0/projects/:pid/environments/:id', { params: { pid: userAProjectId, id: 'dev' } }))
    userAEnvId = env.id

    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: userAProjectId, eid: userAEnvId },
      body: { name: 'ALICE_SECRET', value: 'only-for-alice' },
    }))
  })

  function req({ path, token, method = 'GET', body }: { path: string; token: string; method?: string; body?: object }) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (body) headers['content-type'] = 'application/json'
    return app.handle(new Request(`http://e.ly${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    }))
  }

  test('user B cannot access user A project (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}`, token: userBToken })
    expect(res.status).toBe(403)
  })

  test('user B cannot list user A secrets (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, token: userBToken })
    expect(res.status).toBe(403)
  })

  test('user B cannot create project in user A org (403)', async () => {
    const res = await req({ path: '/api/v0/projects', token: userBToken, method: 'POST', body: { name: 'Sneaky', orgId: userAOrgId } })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A project (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}`, token: userBToken, method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('user B cannot get user A secret value (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets/ALICE_SECRET`, token: userBToken })
    expect(res.status).toBe(403)
  })

  // Write-path isolation — these are the scary paths
  test('user B cannot set secrets in user A env (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, token: userBToken, method: 'POST', body: {
      name: 'INJECTED', value: 'evil',
    } })
    expect(res.status).toBe(403)
  })

  test('user B cannot bulk-set secrets in user A env (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets`, token: userBToken, method: 'PUT', body: {
      secrets: { INJECTED: 'evil' },
    } })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A secret (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}/secrets/ALICE_SECRET`, token: userBToken, method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('user B cannot create environment in user A project (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments`, token: userBToken, method: 'POST', body: {
      name: 'Injected', slug: 'injected',
    } })
    expect(res.status).toBe(403)
  })

  test('user B cannot delete user A environment (403)', async () => {
    const res = await req({ path: `/api/v0/projects/${userAProjectId}/environments/${userAEnvId}`, token: userBToken, method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  // Regression: an object id reached drizzle's relational `where`
  // as filter operators ({ gt: '0' } -> id > '0') and matched a live invite.
  test('invitation accept rejects filter-operator objects as the id', async () => {
    const intruder = await createTestUser({ name: 'Invite Intruder' })
    const db = getDb()
    await db.insert(schema.orgInvitation).values({ orgId: userAOrgId, createdBy: userAId, expiresAt: Date.now() + 60_000 })
    const request = new Request('http://e.ly', { method: 'POST', headers: { authorization: `Bearer ${intruder.token}` } })
    // The cast simulates a malicious client; the type says string, the wire can carry anything.
    const attempt = (invitationId: unknown) => runAction(
      () => acceptInviteAction({ invitationId } as { invitationId: string }),
      { request },
    ).then(() => 'accepted', (e) => e instanceof Error ? e.message : 'accepted (redirect)')

    expect(await attempt({ gt: '0' })).toMatchInlineSnapshot(`"Invalid input: expected string, received object"`)
    expect(await attempt({ isNotNull: true })).toMatchInlineSnapshot(`"Invalid input: expected string, received object"`)
    expect(await db.query.orgMember.findFirst({ where: { orgId: userAOrgId, userId: intruder.user.id } })).toBeUndefined()
  })
})

// ── Secrets derivation — batching & multi-author ────────────────────
// deriveEnvironmentSecretsAndNames powers the project secrets page loader.
// It must (1) derive the selected env's secrets, (2) return the union of
// names across ALL envs, and (3) do it in a SINGLE db.batch round-trip
// regardless of env count — this guards against the old N+1 author lookup
// and the separate names/values round-trips.

describe('secrets derivation — batching & multi-author', () => {
  let af: ReturnType<typeof authedFetch>
  let projectId: string
  let devEnvId: string
  let prodEnvId: string
  let authorAId: string
  let authorBId: string

  beforeAll(async () => {
    const owner = await createTestUser({ name: 'DeriveOwner' })
    af = authedFetch(owner.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Derive Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Derive Project', orgId: org.id } }))
    projectId = proj.id
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    devEnvId = envs.environments.find((e) => e.slug === 'dev')!.id
    prodEnvId = envs.environments.find((e) => e.slug === 'prod')!.id

    // Two distinct authors so the resolver must handle >1 userId.
    const authorA = await createTestUser({ name: 'Author A' })
    const authorB = await createTestUser({ name: 'Author B' })
    authorAId = authorA.user.id
    authorBId = authorB.user.id

    const db = getDb()
    const a = await encrypt('alpha-value')
    const b = await encrypt('beta-value')
    const c = await encrypt('prod-only-value')
    // dev: SHARED_KEY by author A, DEV_ONLY by author B
    await db.insert(schema.secretEvent).values([
      { environmentId: devEnvId, name: 'SHARED_KEY', operation: 'set', valueEncrypted: a.encrypted, iv: a.iv, userId: authorAId },
      { environmentId: devEnvId, name: 'DEV_ONLY', operation: 'set', valueEncrypted: b.encrypted, iv: b.iv, userId: authorBId },
      // prod: SHARED_KEY + PROD_ONLY so the names union spans envs
      { environmentId: prodEnvId, name: 'SHARED_KEY', operation: 'set', valueEncrypted: a.encrypted, iv: a.iv, userId: authorAId },
      { environmentId: prodEnvId, name: 'PROD_ONLY', operation: 'set', valueEncrypted: c.encrypted, iv: c.iv, userId: authorBId },
    ])
  })

  test('derives selected env secrets + name union across all envs', async () => {
    const { secrets, allNames } = await deriveEnvironmentSecretsAndNames({
      environmentIds: [devEnvId, prodEnvId],
      selectedEnvId: devEnvId,
    })

    expect(secrets.map((s) => s.name).sort()).toEqual(['DEV_ONLY', 'SHARED_KEY'])
    // names union spans BOTH environments, not just the selected one
    expect(allNames).toMatchInlineSnapshot(`
      [
        "DEV_ONLY",
        "PROD_ONLY",
        "SHARED_KEY",
      ]
    `)
    // both authors are represented across the derived secrets
    const authorIds = new Set(secrets.map((s) => s.userId))
    expect(authorIds).toEqual(new Set([authorAId, authorBId]))
  })

  test('event sourcing: delete removes a name from both secrets and union', async () => {
    const db = getDb()
    // Delete DEV_ONLY in dev — it should vanish from dev secrets, and since it
    // existed only in dev, it should vanish from the cross-env name union too.
    await db.insert(schema.secretEvent).values({
      environmentId: devEnvId, name: 'DEV_ONLY', operation: 'delete', userId: authorAId,
    })

    const { secrets, allNames } = await deriveEnvironmentSecretsAndNames({
      environmentIds: [devEnvId, prodEnvId],
      selectedEnvId: devEnvId,
    })
    expect(secrets.map((s) => s.name)).toEqual(['SHARED_KEY'])
    expect(allNames).toEqual(['PROD_ONLY', 'SHARED_KEY'])
  })

  test('empty env list returns empty results without querying', async () => {
    const result = await deriveEnvironmentSecretsAndNames({ environmentIds: [], selectedEnvId: null })
    expect(result).toEqual({ secrets: [], allNames: [] })
  })

  test('null selected env returns no secrets but the same full name union', async () => {
    // Order-independent: the name union must NOT depend on which env is
    // selected, so a null selection yields the same union as selecting an env.
    const withSelection = await deriveEnvironmentSecretsAndNames({
      environmentIds: [devEnvId, prodEnvId],
      selectedEnvId: devEnvId,
    })
    const withoutSelection = await deriveEnvironmentSecretsAndNames({
      environmentIds: [devEnvId, prodEnvId],
      selectedEnvId: null,
    })
    expect(withoutSelection.secrets).toEqual([])
    expect(withoutSelection.allNames).toEqual(withSelection.allNames)
    // PROD_ONLY + SHARED_KEY are seeded and never deleted, so always present.
    expect(withoutSelection.allNames).toContain('PROD_ONLY')
    expect(withoutSelection.allNames).toContain('SHARED_KEY')
  })
})

// ── Encryption roundtrip ────────────────────────────────────────────

// ── Secrets list — isEmpty and allNames ─────────────────────────────

describe('secrets list — isEmpty and allNames', () => {
  let af: ReturnType<typeof authedFetch>
  let projectId: string
  let devEnvId: string
  let prodEnvId: string

  beforeAll(async () => {
    const user = await createTestUser({ name: 'ListFieldsUser' })
    af = authedFetch(user.token)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'ListFields Org' } }))
    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'ListFields Project', orgId: org.id } }))
    projectId = proj.id
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    devEnvId = envs.environments.find((e) => e.slug === 'dev')!.id
    prodEnvId = envs.environments.find((e) => e.slug === 'prod')!.id
  })

  test('isEmpty is true for empty-string secrets', async () => {
    // Set a normal secret and an empty-string secret in dev
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST', params: { pid: projectId, eid: devEnvId },
      body: { name: 'HAS_VALUE', value: 'some-value' },
    }))
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST', params: { pid: projectId, eid: devEnvId },
      body: { name: 'EMPTY_SECRET', value: '' },
    }))

    const result = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))

    const hasValue = result.secrets.find((s) => s.name === 'HAS_VALUE')
    const emptySecret = result.secrets.find((s) => s.name === 'EMPTY_SECRET')
    expect(hasValue!.isEmpty).toBe(false)
    expect(emptySecret!.isEmpty).toBe(true)
  })

  test('allNames includes secrets from all environments', async () => {
    // Set a secret only in prod (not in dev)
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST', params: { pid: projectId, eid: prodEnvId },
      body: { name: 'PROD_ONLY', value: 'prod-value' },
    }))

    const result = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))

    // allNames should include secrets from both dev and prod
    expect(result.allNames).toContain('HAS_VALUE')
    expect(result.allNames).toContain('EMPTY_SECRET')
    expect(result.allNames).toContain('PROD_ONLY')

    // PROD_ONLY should NOT be in the secrets array (it's only in prod)
    const prodOnly = result.secrets.find((s) => s.name === 'PROD_ONLY')
    expect(prodOnly).toBeUndefined()
  })
})

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

// ── Auto-join by email domain ───────────────────────────────────────

describe('auto-join by email domain', () => {
  test('creates org with autoJoinDomain when enableAutoJoin is true', async () => {
    const user = await createTestUser({ email: 'admin@acme-test.com', name: 'AcmeAdmin' })
    const db = getDb()
    // Mark email as verified — required before enabling auto-join
    await db.update(schema.user).set({ emailVerified: true }).where(orm.eq(schema.user.id, user.user.id)).limit(1)
    const af = authedFetch(user.token)
    const result = assertOk(await af('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'Acme Auto', enableAutoJoin: true },
    }))
    expect(result.ok).toBe(true)

    // Verify the domain was stored
    const org = await db.query.org.findFirst({ where: { id: result.id } })
    expect(org?.autoJoinDomain).toBe('acme-test.com')
  })

  test('creates org without autoJoinDomain by default', async () => {
    const user = await createTestUser({ email: 'admin2@acme-test.com', name: 'AcmeAdmin2' })
    const af = authedFetch(user.token)
    const result = assertOk(await af('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'Acme No Auto' },
    }))

    const db = getDb()
    const org = await db.query.org.findFirst({ where: { id: result.id } })
    expect(org?.autoJoinDomain).toBeNull()
  })

  test('rejects enableAutoJoin for public email domains', async () => {
    const user = await createTestUser({ email: 'user@gmail.com', name: 'GmailUser' })
    const af = authedFetch(user.token)
    const result = await af('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'Gmail Org', enableAutoJoin: true },
    })
    expect(result).toBeInstanceOf(Error)
  })

  test('autoJoinOrgsByDomain adds user to matching org', async () => {
    // Create an org with auto-join domain (admin must be verified)
    const admin = await createTestUser({ email: 'founder@joinme-test.com', name: 'Founder' })
    const db = getDb()
    await db.update(schema.user).set({ emailVerified: true }).where(orm.eq(schema.user.id, admin.user.id)).limit(1)
    const adminFetch = authedFetch(admin.token)
    const orgResult = assertOk(await adminFetch('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'JoinMe Org', enableAutoJoin: true },
    }))

    // Create a second user with the same domain
    const employee = await createTestUser({ email: 'employee@joinme-test.com', name: 'Employee' })

    // Mark the employee's email as verified (signUpEmail doesn't verify by default)
    await db.update(schema.user)
      .set({ emailVerified: true })
      .where(orm.eq(schema.user.id, employee.user.id))
      .limit(1)

    // Run auto-join
    await autoJoinOrgsByDomain({
      userId: employee.user.id,
      user: { id: employee.user.id, name: 'Employee', email: 'employee@joinme-test.com', emailVerified: true },
    })

    // Verify the employee is now a member
    const member = await db.query.orgMember.findFirst({
      where: { orgId: orgResult.id, userId: employee.user.id },
    })
    expect(member).toBeTruthy()
    expect(member!.role).toBe('member')
  })

  test('autoJoinOrgsByDomain skips unverified emails', async () => {
    const admin = await createTestUser({ email: 'admin@noverify-test.com', name: 'NoVerifyAdmin' })
    const db = getDb()
    await db.update(schema.user).set({ emailVerified: true }).where(orm.eq(schema.user.id, admin.user.id)).limit(1)
    const adminFetch = authedFetch(admin.token)
    const orgResult = assertOk(await adminFetch('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'NoVerify Org', enableAutoJoin: true },
    }))

    const unverified = await createTestUser({ email: 'unverified@noverify-test.com', name: 'Unverified' })

    // Do NOT mark email as verified
    await autoJoinOrgsByDomain({
      userId: unverified.user.id,
      user: { id: unverified.user.id, name: 'Unverified', email: 'unverified@noverify-test.com', emailVerified: false },
    })

    const member = await db.query.orgMember.findFirst({
      where: { orgId: orgResult.id, userId: unverified.user.id },
    })
    expect(member).toBeUndefined()
  })

  test('autoJoinOrgsByDomain is idempotent', async () => {
    const admin = await createTestUser({ email: 'admin@idempotent-test.com', name: 'IdempAdmin' })
    const db = getDb()
    await db.update(schema.user).set({ emailVerified: true }).where(orm.eq(schema.user.id, admin.user.id)).limit(1)
    const adminFetch = authedFetch(admin.token)
    const orgResult = assertOk(await adminFetch('/api/v0/orgs', {
      method: 'POST',
      body: { name: 'Idempotent Org', enableAutoJoin: true },
    }))

    const joiner = await createTestUser({ email: 'joiner@idempotent-test.com', name: 'Joiner' })
    await db.update(schema.user)
      .set({ emailVerified: true })
      .where(orm.eq(schema.user.id, joiner.user.id))
      .limit(1)

    const session = {
      userId: joiner.user.id,
      user: { id: joiner.user.id, name: 'Joiner', email: 'joiner@idempotent-test.com', emailVerified: true },
    }

    // Run twice — should not throw
    await autoJoinOrgsByDomain(session)
    await autoJoinOrgsByDomain(session)

    // Should still have exactly one membership
    const members = await db.query.orgMember.findMany({
      where: { orgId: orgResult.id, userId: joiner.user.id },
    })
    expect(members.length).toBe(1)
  })

  test('autoJoinOrgsByDomain skips common email domains', async () => {
    // Even if somehow an org has autoJoinDomain set, users with gmail should not auto-join
    // (the domain blocklist check is in autoJoinOrgsByDomain itself)
    const gmailUser = await createTestUser({ email: 'someone@gmail.com', name: 'GmailSkip' })
    const db = getDb()
    await db.update(schema.user)
      .set({ emailVerified: true })
      .where(orm.eq(schema.user.id, gmailUser.user.id))
      .limit(1)

    // This should be a no-op, not throw
    await autoJoinOrgsByDomain({
      userId: gmailUser.user.id,
      user: { id: gmailUser.user.id, name: 'GmailSkip', email: 'someone@gmail.com', emailVerified: true },
    })
  })
})

// ── Member access — granular project + secret restrictions ──────────
// Tests for the memberAccess table that gates per-member project access
// restrictions. Admins always bypass them. orgMember.projectAccess 'all'
// ignores the rules; 'selected' only allows listed projects (none if empty).

describe('member access — project scoping', () => {
  let adminToken: string
  let memberToken: string
  let memberId: string // orgMember.id
  let memberUserId: string
  let orgId: string
  let projectAId: string
  let projectBId: string
  let projectADevEnvId: string
  let projectBDevEnvId: string

  beforeAll(async () => {
    const admin = await createTestUser({ name: 'AccessAdmin' })
    adminToken = admin.token
    const member = await createTestUser({ name: 'AccessMember' })
    memberToken = member.token
    memberUserId = member.user.id

    const af = authedFetch(adminToken)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Access Org' } }))
    orgId = org.id

    // Add member to org
    const db = getDb()
    const [memberRow] = await db.insert(schema.orgMember)
      .values({ orgId, userId: memberUserId, role: 'member' })
      .returning({ id: schema.orgMember.id })
    memberId = memberRow!.id

    // Create two projects
    const projA = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Project A', orgId } }))
    const projB = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Project B', orgId } }))
    projectAId = projA.id
    projectBId = projB.id

    // Get env IDs
    const envsA = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectAId } }))
    const envsB = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectBId } }))
    projectADevEnvId = envsA.environments.find((e) => e.slug === 'dev')!.id
    projectBDevEnvId = envsB.environments.find((e) => e.slug === 'dev')!.id

    // Seed secrets in both projects
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT', params: { pid: projectAId, eid: projectADevEnvId },
      body: { secrets: { A_SECRET: 'a-value', A_OTHER: 'a-other' } },
    }))
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT', params: { pid: projectBId, eid: projectBDevEnvId },
      body: { secrets: { B_SECRET: 'b-value' } },
    }))
  })

  const restrictTo = async (projectIds: string[]) => {
    const db = getDb()
    await db.update(schema.orgMember).set({ projectAccess: 'selected' }).where(orm.eq(schema.orgMember.id, memberId))
    for (const projectId of projectIds) await db.insert(schema.memberAccess).values({ orgMemberId: memberId, projectId })
  }
  const unrestrict = async () => {
    const db = getDb()
    await db.update(schema.orgMember).set({ projectAccess: 'all' }).where(orm.eq(schema.orgMember.id, memberId))
    await db.delete(schema.memberAccess).where(orm.eq(schema.memberAccess.orgMemberId, memberId))
  }

  test('projectAccess all = full access', async () => {
    const mf = authedFetch(memberToken)
    // Member with no access rules can see all projects
    const projects = assertOk(await mf('/api/v0/projects'))
    const orgProjects = projects.projects.filter((p) => p.orgId === orgId)
    expect(orgProjects.length).toBe(2)

    // Can access both projects' secrets
    const secretsA = assertOk(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectAId, eid: projectADevEnvId },
    }))
    expect(secretsA.secrets.length).toBeGreaterThanOrEqual(1)

    const secretsB = assertOk(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectBId, eid: projectBDevEnvId },
    }))
    expect(secretsB.secrets.length).toBeGreaterThanOrEqual(1)
  })

  test('access rules restrict to listed projects only', async () => {
    await restrictTo([projectAId])

    const mf = authedFetch(memberToken)

    // Can see Project A
    const projectA = assertOk(await mf('/api/v0/projects/:id', { params: { id: projectAId } }))
    expect(projectA.name).toBe('Project A')

    // Cannot see Project B (403)
    assertErrorStatus(await mf('/api/v0/projects/:id', { params: { id: projectBId } }), 403)

    // Project list only shows Project A
    const projects = assertOk(await mf('/api/v0/projects'))
    const orgProjects = projects.projects.filter((p) => p.orgId === orgId)
    expect(orgProjects.map((p) => p.name)).toEqual(['Project A'])

    // Cannot access Project B secrets (403 from requireSecretsApiAuth)
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectBId, eid: projectBDevEnvId },
    }), 403)

    await unrestrict()
  })

  test('admin always has full access regardless of access rules', async () => {
    const access = await getMemberProjectAccess({ userId: memberUserId, orgId, projectId: projectBId })
    // After cleanup, member should have full access again
    expect(access).toBe(true)

    // Admin always has full access
    const af = authedFetch(adminToken)
    const projectB = assertOk(await af('/api/v0/projects/:id', { params: { id: projectBId } }))
    expect(projectB.name).toBe('Project B')
  })

  test('getAccessibleProjectIds returns null for unrestricted member', async () => {
    const ids = await getAccessibleProjectIds(memberUserId, orgId)
    expect(ids).toBeNull()
  })

  test('getAccessibleProjectIds returns project list for restricted member', async () => {
    await restrictTo([projectAId])
    expect(await getAccessibleProjectIds(memberUserId, orgId)).toEqual([projectAId])
    await unrestrict()
  })

  // Regression: zero member_access rows used to mean "all projects", so
  // deleting a member's last allowed project (FK cascade) unlocked every project.
  test('deleting the last allowed project does not unlock the others', async () => {
    const af = authedFetch(adminToken)
    const temp = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Temp', orgId } }))
    await restrictTo([temp.id])
    assertOk(await authedFetch(memberToken)('/api/v0/projects/:id', { method: 'DELETE', params: { id: temp.id } }))
    expect(await getAccessibleProjectIds(memberUserId, orgId)).toEqual([])
    assertErrorStatus(await authedFetch(memberToken)('/api/v0/projects/:id', { params: { id: projectBId } }), 403)
    await unrestrict()
  })
})

describe('environment access roles', () => {
  let adminToken: string
  let memberToken: string
  let orgId: string
  let projectId: string
  let devEnvId: string
  let prodEnvId: string

  beforeAll(async () => {
    const admin = await createTestUser({ name: 'EnvRoleAdmin' })
    adminToken = admin.token
    const member = await createTestUser({ name: 'EnvRoleMember' })
    memberToken = member.token

    const af = authedFetch(adminToken)
    const org = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'EnvRole Org' } }))
    orgId = org.id

    const db = getDb()
    await db.insert(schema.orgMember)
      .values({ orgId, userId: member.user.id, role: 'member' })

    const proj = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'EnvRole Project', orgId } }))
    projectId = proj.id
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectId } }))
    devEnvId = envs.environments.find((e) => e.slug === 'dev')!.id
    prodEnvId = envs.environments.find((e) => e.slug === 'prod')!.id

    // Restrict prod environment to admin-only BEFORE any secret operations
    await db.update(schema.environment)
      .set({ accessRole: 'admin' })
      .where(orm.eq(schema.environment.id, prodEnvId))
      .limit(1)

    // Seed secrets in both environments (admin token bypasses prod restriction)
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT', params: { pid: projectId, eid: devEnvId },
      body: { secrets: { DEV_SECRET: 'dev-value' } },
    }))
    assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'PUT', params: { pid: projectId, eid: prodEnvId },
      body: { secrets: { PROD_SECRET: 'prod-value' } },
    }))
  })

  test('member can access dev environment (accessRole=member)', async () => {
    const mf = authedFetch(memberToken)
    const result = assertOk(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))
    expect(result.secrets.length).toBeGreaterThanOrEqual(1)
    // Regression: allNames included names from every env, even admin-only ones.
    expect(result.allNames).toContain('DEV_SECRET')
    expect(result.allNames).not.toContain('PROD_SECRET')
    const admin = assertOk(await authedFetch(adminToken)('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))
    expect(admin.allNames).toContain('PROD_SECRET')
  })

  test('env-scoped token only sees names from its own envs', async () => {
    const db = getDb()
    const admin = await db.query.orgMember.findFirst({ where: { orgId, role: 'admin' }, columns: { userId: true } })
    const { key } = await insertApiToken({ name: 'dev-only', projectId, createdBy: admin!.userId, environmentIds: [devEnvId] })
    const result = assertOk(await authedFetch(key)('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: devEnvId },
    }))
    expect(result.allNames).not.toContain('PROD_SECRET')
  })

  test('member cannot access prod environment (accessRole=admin) — 403', async () => {
    const mf = authedFetch(memberToken)
    // List secrets
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      params: { pid: projectId, eid: prodEnvId },
    }), 403)
    // Get secret value
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: prodEnvId, name: 'PROD_SECRET' },
    }), 403)
    // Set secret
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:eid/secrets', {
      method: 'POST',
      params: { pid: projectId, eid: prodEnvId },
      body: { name: 'INJECTED', value: 'evil' },
    }), 403)
    // Delete secret
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      method: 'DELETE',
      params: { pid: projectId, eid: prodEnvId, name: 'PROD_SECRET' },
    }), 403)
  })

  test('admin can always access admin-restricted environments', async () => {
    const af = authedFetch(adminToken)
    const result = assertOk(await af('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: prodEnvId, name: 'PROD_SECRET' },
    }))
    expect(result.value).toBe('prod-value')
  })

  test('member can still access dev secrets normally', async () => {
    const mf = authedFetch(memberToken)
    const result = assertOk(await mf('/api/v0/projects/:pid/environments/:eid/secrets/:name', {
      params: { pid: projectId, eid: devEnvId, name: 'DEV_SECRET' },
    }))
    expect(result.value).toBe('dev-value')
  })

  test('download blocked for member on admin-only environment', async () => {
    const res = await app.handle(new Request(
      `http://e.ly/api/v0/projects/${projectId}/environments/${prodEnvId}/secrets/download?format=json`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    ))
    expect(res.status).toBe(403)
  })

  // Regression: the API-token branch never checked accessRole, so a member
  // could create a project-wide token and read admin-only envs with it.
  test('admin-only env needs a token created by a current admin', async () => {
    const db = getDb()
    const admin = await db.query.orgMember.findFirst({ where: { orgId, role: 'admin' }, columns: { userId: true } })
    const member = await db.query.orgMember.findFirst({ where: { orgId, role: 'member' }, columns: { userId: true } })
    const memberKey = (await insertApiToken({ name: 'member-token', projectId, createdBy: member!.userId })).key
    const adminKey = (await insertApiToken({ name: 'admin-token', projectId, createdBy: admin!.userId })).key
    const path = '/api/v0/projects/:pid/environments/:eid/secrets/:name' as const

    assertErrorStatus(await authedFetch(memberKey)(path, { params: { pid: projectId, eid: prodEnvId, name: 'PROD_SECRET' } }), 403)
    assertOk(await authedFetch(memberKey)(path, { params: { pid: projectId, eid: devEnvId, name: 'DEV_SECRET' } }))
    expect(assertOk(await authedFetch(adminKey)(path, { params: { pid: projectId, eid: prodEnvId, name: 'PROD_SECRET' } })).value).toBe('prod-value')
  })

  // Regression: authz lookups were memoized for up to 15 minutes.
  test('making an env admin-only takes effect immediately', async () => {
    const db = getDb()
    const mf = authedFetch(memberToken)
    const path = '/api/v0/projects/:pid/environments/:eid/secrets/:name' as const
    assertOk(await mf(path, { params: { pid: projectId, eid: devEnvId, name: 'DEV_SECRET' } }))
    await db.update(schema.environment).set({ accessRole: 'admin' }).where(orm.eq(schema.environment.id, devEnvId))
    assertErrorStatus(await mf(path, { params: { pid: projectId, eid: devEnvId, name: 'DEV_SECRET' } }), 403)
    await db.update(schema.environment).set({ accessRole: 'member' }).where(orm.eq(schema.environment.id, devEnvId))
  })
})

// ── Authorization outside the secrets API ───────────────────────────
// Environment and project routes used to check org membership only, so a
// member scoped to one project could delete another project's admin-only
// prod. Tests adapted from #13 and #15 by Nikolai Kolodziej.
describe('authorization — project scoping and admin-only environments', () => {
  let adminToken: string
  let memberToken: string
  let scopedToken: string
  let orgId: string
  let projectAId: string
  let aDevEnvId: string
  let aProdEnvId: string

  beforeAll(async () => {
    const admin = await createTestUser({ name: 'AuthzAdmin' })
    const member = await createTestUser({ name: 'AuthzMember' })
    const scoped = await createTestUser({ name: 'AuthzScoped' })
    adminToken = admin.token
    memberToken = member.token
    scopedToken = scoped.token
    const af = authedFetch(adminToken)
    orgId = assertOk(await af('/api/v0/orgs', { method: 'POST', body: { name: 'Authz Org' } })).id
    projectAId = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Authz A', orgId } })).id
    const projectBId = assertOk(await af('/api/v0/projects', { method: 'POST', body: { name: 'Authz B', orgId } })).id
    const envs = assertOk(await af('/api/v0/projects/:pid/environments', { params: { pid: projectAId } }))
    aDevEnvId = envs.environments.find((e) => e.slug === 'dev')!.id
    aProdEnvId = envs.environments.find((e) => e.slug === 'prod')!.id

    const db = getDb()
    await db.insert(schema.orgMember).values({ orgId, userId: member.user.id, role: 'member' })
    const [scopedRow] = await db.insert(schema.orgMember)
      .values({ orgId, userId: scoped.user.id, role: 'member' })
      .returning({ id: schema.orgMember.id })
    await db.update(schema.orgMember).set({ projectAccess: 'selected' }).where(orm.eq(schema.orgMember.id, scopedRow!.id))
    await db.insert(schema.memberAccess).values({ orgMemberId: scopedRow!.id, projectId: projectBId })
    await db.update(schema.environment).set({ accessRole: 'admin' }).where(orm.eq(schema.environment.id, aProdEnvId))
  })

  test('a member scoped to another project gets 403 on every environment route', async () => {
    const sf = authedFetch(scopedToken)
    assertErrorStatus(await sf('/api/v0/projects/:pid/environments', { params: { pid: projectAId } }), 403)
    assertErrorStatus(await sf('/api/v0/projects/:pid/environments/:id', { params: { pid: projectAId, id: aDevEnvId } }), 403)
    assertErrorStatus(await sf('/api/v0/projects/:pid/environments', {
      method: 'POST', params: { pid: projectAId }, body: { name: 'Staging', slug: 'staging' },
    }), 403)
    assertErrorStatus(await sf('/api/v0/projects/:pid/environments/:id', {
      method: 'PATCH', params: { pid: projectAId, id: aDevEnvId }, body: { name: 'Renamed' },
    }), 403)
    assertErrorStatus(await sf('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE', params: { pid: projectAId, id: aDevEnvId },
    }), 403)
  })

  test('a member cannot rename or delete an admin-only env, or its project', async () => {
    const mf = authedFetch(memberToken)
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:id', {
      method: 'PATCH', params: { pid: projectAId, id: aProdEnvId }, body: { name: 'Pwned' },
    }), 403)
    assertErrorStatus(await mf('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE', params: { pid: projectAId, id: aProdEnvId },
    }), 403)
    assertErrorStatus(await mf('/api/v0/projects/:id', { method: 'DELETE', params: { id: projectAId } }), 403)
    expect(await getDb().query.environment.findFirst({ where: { id: aProdEnvId } })).toBeDefined()
  })

  test('a member manages the environments they can read', async () => {
    const mf = authedFetch(memberToken)
    const created = assertOk(await mf('/api/v0/projects/:pid/environments', {
      method: 'POST', params: { pid: projectAId }, body: { name: 'QA', slug: 'qa' },
    }))
    assertOk(await mf('/api/v0/projects/:pid/environments/:id', {
      method: 'PATCH', params: { pid: projectAId, id: created.id }, body: { name: 'QA 2' },
    }))
    assertOk(await mf('/api/v0/projects/:pid/environments/:id', {
      method: 'DELETE', params: { pid: projectAId, id: created.id },
    }))
  })

  test('a removed member loses org access on the next request', async () => {
    const extra = await createTestUser({ name: 'AuthzRemoved' })
    await getDb().insert(schema.orgMember).values({ orgId, userId: extra.user.id, role: 'member' })
    const xf = authedFetch(extra.token)
    const createProject = (name: string) => xf('/api/v0/projects', { method: 'POST', body: { name, orgId } })
    assertOk(await createProject('Before removal'))
    await getDb().delete(schema.orgMember).where(orm.and(
      orm.eq(schema.orgMember.orgId, orgId),
      orm.eq(schema.orgMember.userId, extra.user.id),
    ))
    assertErrorStatus(await createProject('After removal'), 403)
  })
})

// ── Time formatting ─────────────────────────────────────────────────
//
// These guard the hydration bug class described in lib/utils.ts: the worker
// renders in UTC and the browser renders in the visitor's zone, so any
// formatter that reads the ambient timezone or Date.now() produces different
// text on each side. React reports that as error #418 and shows the user a
// date that is not theirs.

describe('formatTime', () => {
  // 2026-07-29T23:16Z — a real production timestamp that rendered as
  // "Jul 29" on the worker and "Jul 30" in a UTC+2 browser.
  const nearMidnightUtc = Date.UTC(2026, 6, 29, 23, 16)

  test('same timestamp formats to a different day per timezone', () => {
    expect(formatAbsoluteDate({ ts: nearMidnightUtc, timeZone: 'UTC' })).toMatchInlineSnapshot(`"Jul 29, 2026"`)
    expect(formatAbsoluteDate({ ts: nearMidnightUtc, timeZone: 'Europe/Rome' })).toMatchInlineSnapshot(`"Jul 30, 2026"`)
  })

  test('output depends only on its arguments, never on ambient state', () => {
    // Called twice, seconds apart in wall-clock terms, with the same inputs.
    const now = Date.UTC(2026, 6, 31, 12, 0)
    const first = formatTime({ ts: nearMidnightUtc, now, timeZone: 'UTC' })
    const second = formatTime({ ts: nearMidnightUtc, now, timeZone: 'UTC' })
    expect(first).toBe(second)
    expect(first).toMatchInlineSnapshot(`"Jul 29, 2026"`)
  })

  test('relative buckets', () => {
    const now = Date.UTC(2026, 6, 31, 12, 0)
    expect(formatTime({ ts: now - 30_000, now, timeZone: 'UTC' })).toMatchInlineSnapshot(`"just now"`)
    expect(formatTime({ ts: now - 5 * 60_000, now, timeZone: 'UTC' })).toMatchInlineSnapshot(`"5m ago"`)
    expect(formatTime({ ts: now - 3 * 3_600_000, now, timeZone: 'UTC' })).toMatchInlineSnapshot(`"3h ago"`)
    expect(formatTime({ ts: now - 3 * 86_400_000, now, timeZone: 'UTC' })).toMatchInlineSnapshot(`"Jul 28, 2026"`)
  })

  test('a bucket boundary crossing between SSR and hydration changes the text', () => {
    // This is precisely why <TimeAgo> renders the absolute UTC date on the
    // first pass instead of a relative bucket: the server and the hydrating
    // client do not share a clock.
    const ssr = Date.UTC(2026, 6, 31, 12, 0, 0)
    const hydration = ssr + 400 // ~400ms later, crossing the minute boundary
    const ts = ssr - 119_600
    expect(formatTime({ ts, now: ssr, timeZone: 'UTC' })).toMatchInlineSnapshot(`"1m ago"`)
    expect(formatTime({ ts, now: hydration, timeZone: 'UTC' })).toMatchInlineSnapshot(`"2m ago"`)
  })
})

describe('session tokens read out of D1', () => {
  const call = (path: string, init: { body?: unknown; token?: string } = {}) => app.handle(new Request(`http://e.ly${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }))

  test('a raw session token copied out of D1 is refused', async () => {
    const { user } = await createTestUser()
    const [row] = await getDb().select().from(schema.session).where(orm.eq(schema.session.userId, user.id))
    const res = await call('/api/v0/me', { token: row!.token })
    // CLI logins from before this change are raw tokens too: tell them what to do
    expect({ status: res.status, body: await res.json() }).toEqual({
      status: 401,
      body: { error: 'not signed in, or the session expired: run `sigillo login`' },
    })
  })

  test('the device flow hands the CLI a signed token, and its raw part alone is refused', async () => {
    const { token: approver } = await createTestUser()
    const code = await (await call('/api/auth/device/code', { body: { client_id: 'sigillo-cli' } })).json() as { device_code: string; user_code: string }
    // Like the /device page: claim the code while signed in, then approve it
    expect((await call(`/api/auth/device?user_code=${code.user_code}`, { token: approver })).status).toBe(200)
    expect((await call('/api/auth/device/approve', { body: { userCode: code.user_code }, token: approver })).status).toBe(200)
    const issued = await (await call('/api/auth/device/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: 'sigillo-cli' },
    })).json() as { access_token: string }
    expect({
      signed: (await call('/api/v0/me', { token: issued.access_token })).status,
      raw: (await call('/api/v0/me', { token: issued.access_token.split('.')[0] })).status,
    }).toEqual({ signed: 200, raw: 401 })
  })
})
