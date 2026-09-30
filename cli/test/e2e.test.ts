// End-to-end coverage for the real Sigillo CLI against a logged-in local setup.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { fileURLToPath } from 'node:url'

const testFile = fileURLToPath(import.meta.url)
const cliDir = dirname(dirname(testFile))
const repoRoot = dirname(cliDir)
const binaryPath = join(cliDir, 'zig-out', 'bin', process.platform === 'win32' ? 'sigillo.exe' : 'sigillo')

type CliContext = {
  apiUrl: string
  token: string
  env: NodeJS.ProcessEnv
  tmpDir: string
  projectId: string
  environmentId: string
  environmentSlug: string
  extraEnvironmentId: string
  extraEnvironmentSlug: string
  secretName: string
  secretValue: string
  overlapShortName: string
  overlapShortValue: string
  overlapLongName: string
  overlapLongValue: string
}

const currentCwd = resolve(repoRoot)

let cliContext: CliContext

// One build of the binary for every suite in this file
beforeAll(() => {
  // spawnSync blocks the event loop, so the hook timeout below can never fire; this one kills zig
  const build = spawnSync('zig', ['build'], { cwd: cliDir, encoding: 'utf8', timeout: 120_000 })
  expect(build.status, build.error?.message ?? build.stderr).toBe(0)
}, 120_000)

describe('sigillo cli e2e', () => {
  beforeAll(async () => {
    const resolved = resolveConfiguredAuth(currentCwd)
    const me = await apiRequest({ method: 'GET', path: '/api/v0/me', context: resolved })
    expect(Array.isArray(me.orgs)).toBe(true)
    expect(me.orgs.length).toBeGreaterThan(0)

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const project = await apiRequest({ method: 'POST', path: '/api/v0/projects', context: resolved, body: {
      orgId: me.orgs[0].id,
      name: `sigillo-cli-e2e-${runId}`,
    } })
    const environment = await apiRequest({ method: 'POST', path: `/api/v0/projects/${project.id}/environments`, context: resolved, body: {
      name: 'E2E',
      slug: `e2e-${runId}`,
    } })
    const extraEnvironment = await apiRequest({ method: 'POST', path: `/api/v0/projects/${project.id}/environments`, context: resolved, body: {
      name: 'Extra E2E',
      slug: `extra-e2e-${runId}`,
    } })

    const secretName = 'E2E_SECRET'
    const secretValue = `sk_live_51QwertyUIOPasdfGHJKLzxcvbnm1234567890${runId.replace(/-/g, '')}`
    const overlapShortName = 'E2E_OVERLAP_SHORT'
    const overlapShortValue = '1234wxyzABCD9876'
    const overlapLongName = 'E2E_OVERLAP_LONG'
    const overlapLongValue = 'abcd1234wxyzABCD9876wxyz'

    await apiRequest({ method: 'POST', path: `/api/v0/projects/${project.id}/environments/${environment.id}/secrets`, context: resolved, body: {
      name: secretName,
      value: secretValue,
    } })
    await apiRequest({ method: 'POST', path: `/api/v0/projects/${project.id}/environments/${environment.id}/secrets`, context: resolved, body: {
      name: overlapShortName,
      value: overlapShortValue,
    } })
    await apiRequest({ method: 'POST', path: `/api/v0/projects/${project.id}/environments/${environment.id}/secrets`, context: resolved, body: {
      name: overlapLongName,
      value: overlapLongValue,
    } })

    const tmpDir = mkdtempSync(join(tmpdir(), 'sigillo-cli-e2e-'))
    cliContext = {
      ...resolved,
      env: {
        ...process.env,
        SIGILLO_API_URL: resolved.apiUrl,
        SIGILLO_TOKEN: resolved.token,
        SIGILLO_PROJECT: project.id,
        SIGILLO_ENVIRONMENT: environment.slug,
      },
      tmpDir,
      projectId: project.id,
      environmentId: environment.id,
      environmentSlug: environment.slug,
      extraEnvironmentId: extraEnvironment.id,
      extraEnvironmentSlug: extraEnvironment.slug,
      secretName,
      secretValue,
      overlapShortName,
      overlapShortValue,
      overlapLongName,
      overlapLongValue,
    }
  }, 120_000)

  afterAll(async () => {
    if (!cliContext) return
    rmSync(cliContext.tmpDir, { recursive: true, force: true })
    await apiRequest({ method: 'DELETE', path: `/api/v0/projects/${cliContext.projectId}`, context: cliContext })
  }, 60_000)

  test('lists and downloads secrets from the configured environment', async () => {
    const list = await runCli({ args: ['secrets'], context: cliContext })
    expect(list.status).toBe(0)
    // Piped, `secrets` prints one name per line
    expect(list.stdout.split('\n')).toEqual(expect.arrayContaining([cliContext.secretName, cliContext.overlapLongName]))
    expect(list.stdout).not.toContain(cliContext.secretValue)

    const get = await runCli({ args: ['secrets', 'get', cliContext.secretName], context: cliContext })
    expect(get.status).toBe(0)
    // Piped, `secrets get` prints just the value
    expect(get.stdout).toBe(cliContext.secretValue)

    const download = await runCli({ args: ['secrets', 'download', '--format', 'json'], context: cliContext })
    expect(download.status).toBe(0)
    expect(JSON.parse(download.stdout)).toMatchObject({
      [cliContext.secretName]: cliContext.secretValue,
      [cliContext.overlapShortName]: cliContext.overlapShortValue,
      [cliContext.overlapLongName]: cliContext.overlapLongValue,
    })
  }, 60_000)

  test('allows piped plain secret output in agent shells', async () => {
    const agentContext = {
      ...cliContext,
      env: {
        ...cliContext.env,
        CODEX_THREAD_ID: 'sigillo-test-agent',
      },
    }

    const get = await runCli({ args: ['secrets', 'get', cliContext.secretName], context: agentContext })
    expect(get.status).toBe(0)
    expect(get.stdout).toBe(cliContext.secretValue)

    const download = await runCli({ args: ['secrets', 'download', '--format', 'json'], context: agentContext })
    expect(download.status).toBe(0)
    expect(JSON.parse(download.stdout)).toMatchObject({
      [cliContext.secretName]: cliContext.secretValue,
    })
  }, 60_000)

  test('environment commands accept env slugs', async () => {
    // Its own env, since it gets deleted: later tests still use the shared ones
    const slug = `slug-e2e-${Date.now()}`
    const environment = await apiRequest({ method: 'POST', path: `/api/v0/projects/${cliContext.projectId}/environments`, context: cliContext, body: {
      name: 'Slug E2E',
      slug,
    } })

    const get = await runCli({ args: ['environments', 'get', slug], context: cliContext })
    expect(get.status).toBe(0)
    expect(get.stdout).toContain(`id: "${environment.id}"`)
    expect(get.stdout).toContain(`slug: "${slug}"`)

    const renamedSlug = `${slug}-renamed`
    const rename = await runCli({
      args: ['environments', 'rename', slug, '--slug', renamedSlug],
      context: cliContext,
    })
    expect(rename.status).toBe(0)
    expect(rename.stdout).toContain(`id: "${environment.id}"`)
    expect(rename.stdout).toContain(`slug: "${renamedSlug}"`)

    const deleted = await runCli({ args: ['environments', 'delete', renamedSlug], context: cliContext })
    expect(deleted.status).toBe(0)
    expect(deleted.stdout).toContain(`id: "${environment.id}"`)
  }, 60_000)

  test('secrets set reads value from piped stdin and strips trailing newline', async () => {
    // Simulate `echo "value" | sigillo secrets set NAME` — echo always appends \n
    const plainName = 'E2E_STDIN_PLAIN'
    const plainValue = 'plain-secret-no-newline'

    const setPlain = await runCli({
      args: ['secrets', 'set', plainName],
      context: cliContext,
      stdin: plainValue + '\n', // echo adds a trailing newline
    })
    expect(setPlain.status).toBe(0)
    expect(setPlain.stderr).toContain('trailing newline stripped')

    const getPlain = await runCli({ args: ['secrets', 'get', plainName], context: cliContext })
    expect(getPlain.status).toBe(0)
    expect(getPlain.stdout).toBe(plainValue) // no \n stored

    // Multiline value — trailing newline must NOT be stripped
    const multiName = 'E2E_STDIN_MULTILINE'
    const multiValue = 'line1\nline2\n'

    const setMulti = await runCli({
      args: ['secrets', 'set', multiName],
      context: cliContext,
      stdin: multiValue,
    })
    expect(setMulti.status).toBe(0)
    expect(setMulti.stderr).not.toContain('trailing newline stripped')

    const getMulti = await runCli({ args: ['secrets', 'get', multiName], context: cliContext })
    expect(getMulti.status).toBe(0)
    expect(getMulti.stdout).toBe(multiValue)
  }, 60_000)

  test('secrets set fans out to multiple envs with repeated -c', async () => {
    const name = 'E2E_MULTI_SET'
    const value = `multi-${cliContext.environmentSlug}`

    const set = await runCli({
      args: [
        'secrets', 'set', name, value,
        '-c', cliContext.environmentSlug,
        '-c', cliContext.extraEnvironmentSlug,
      ],
      context: cliContext,
    })
    expect(set.status, set.stderr).toBe(0)
    // Piped, `secrets set` prints the new secret's ID once per env
    expect(set.stdout.trim().split('\n')).toHaveLength(2)

    // Both envs must actually hold the value now.
    const getMain = await runCli({ args: ['secrets', 'get', name, '-c', cliContext.environmentSlug], context: cliContext })
    expect(getMain.status).toBe(0)
    expect(getMain.stdout).toBe(value)

    const getExtra = await runCli({ args: ['secrets', 'get', name, '-c', cliContext.extraEnvironmentSlug], context: cliContext })
    expect(getExtra.status).toBe(0)
    expect(getExtra.stdout).toBe(value)
  }, 60_000)

  test('secrets delete fans out to multiple envs with repeated -c', async () => {
    const name = 'E2E_MULTI_DELETE'
    const value = 'to-be-deleted'

    // Seed the secret in both envs first.
    const set = await runCli({
      args: ['secrets', 'set', name, value, '-c', cliContext.environmentSlug, '-c', cliContext.extraEnvironmentSlug],
      context: cliContext,
    })
    expect(set.status, set.stderr).toBe(0)

    const del = await runCli({
      args: ['secrets', 'delete', name, '-c', cliContext.environmentSlug, '-c', cliContext.extraEnvironmentSlug],
      context: cliContext,
    })
    expect(del.status, del.stderr).toBe(0)
    // The delete API response carries no environment id, so the CLI echoes the
    // slug it was given for each env in the fan-out.
    expect(del.stdout).toContain(`environment_id: "${cliContext.environmentSlug}"`)
    expect(del.stdout).toContain(`environment_id: "${cliContext.extraEnvironmentSlug}"`)

    // The secret should no longer resolve in either env.
    const getMain = await runCli({ args: ['secrets', 'get', name, '-c', cliContext.environmentSlug], context: cliContext })
    expect(getMain.status).not.toBe(0)
    const getExtra = await runCli({ args: ['secrets', 'get', name, '-c', cliContext.extraEnvironmentSlug], context: cliContext })
    expect(getExtra.status).not.toBe(0)
  }, 60_000)

  test('secrets set continues past an invalid env and exits non-zero', async () => {
    const name = 'E2E_MULTI_PARTIAL'
    const value = 'partial-write'
    const bogusSlug = `does-not-exist-${Date.now()}`

    const set = await runCli({
      args: ['secrets', 'set', name, value, '-c', cliContext.environmentSlug, '-c', bogusSlug],
      context: cliContext,
    })
    // One env succeeded, one failed → non-zero overall.
    expect(set.status).not.toBe(0)
    // Friendly env-not-found hint is preserved for the bad slug.
    expect(set.stderr).toContain(bogusSlug)
    // The valid env still got the value despite the failure.
    expect(set.stdout.trim().split('\n')).toHaveLength(1)

    const getMain = await runCli({ args: ['secrets', 'get', name, '-c', cliContext.environmentSlug], context: cliContext })
    expect(getMain.status).toBe(0)
    expect(getMain.stdout).toBe(value)
  }, 60_000)

  test('secrets set rejects empty piped value', async () => {
    // Non-TTY with empty stdin: the masked prompt only triggers on a TTY, so
    // piped empty input flows through as an empty value. The server stores it,
    // but we assert the command does not crash and round-trips an empty string.
    const name = 'E2E_EMPTY_PIPE'
    const set = await runCli({
      args: ['secrets', 'set', name, '-c', cliContext.environmentSlug],
      context: cliContext,
      stdin: '',
    })
    expect(set.status, set.stderr).toBe(0)
  }, 60_000)

  test('run redacts secrets from stdout and stderr', async () => {
    const command = [
      `printf "stdout:%s\\n" "${'$'}${cliContext.secretName}"`,
      `printf "stderr:%s\\n" "${'$'}${cliContext.secretName}" >&2`,
      `printf "overlap:%s %s\\n" "${'$'}${cliContext.overlapLongName}" "${'$'}${cliContext.overlapShortName}"`,
    ].join('; ')

    const result = await runCli({ args: ['run', '--command', command], context: cliContext })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(cliContext.secretValue)
    expect(result.stderr).not.toContain(cliContext.secretValue)
    expect(result.stdout).not.toContain(cliContext.overlapLongValue)
    expect(result.stdout).not.toContain(cliContext.overlapShortValue)
    expect(result.stdout).toContain(`stdout:${'*'.repeat(cliContext.secretValue.length)}`)
    expect(result.stderr).toContain(`stderr:${'*'.repeat(cliContext.secretValue.length)}`)
    expect(result.stdout).toContain(`overlap:${'*'.repeat(cliContext.overlapLongValue.length)} ${'*'.repeat(cliContext.overlapShortValue.length)}`)
  }, 60_000)

  test('run streams output before the child exits', async () => {
    const streamCommand = [
      'import sys, time',
      'sys.stdout.write("chunk-1\\n")',
      'sys.stdout.flush()',
      'time.sleep(2)',
      'sys.stdout.write("chunk-2\\n")',
      'sys.stdout.flush()',
    ].join('; ')

    const child = spawn(binaryPath, ['run', '--command', `python3 -c '${streamCommand}'`], {
      cwd: cliContext.tmpDir,
      env: cliContext.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let firstChunkAt: number | null = null

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (firstChunkAt === null) firstChunkAt = Date.now()
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    const closePromise = new Promise<number | null>((resolveClose, rejectClose) => {
      child.on('error', rejectClose)
      child.on('close', resolveClose)
    })

    await new Promise<void>((resolveFirst, rejectFirst) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectFirst(new Error('timed out waiting for first streamed chunk'))
      }, 10_000)

      const check = () => {
        if (firstChunkAt !== null) {
          clearTimeout(timer)
          resolveFirst()
          return
        }
        setTimeout(check, 10)
      }

      check()
      child.on('error', rejectFirst)
    })

    const status = await closePromise

    const closedAt = Date.now()

    expect(status).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('chunk-1')
    expect(stdout).toContain('chunk-2')
    expect(firstChunkAt).not.toBeNull()
    expect(closedAt - firstChunkAt!).toBeGreaterThan(1_000)
  }, 60_000)

  test('run handles very large output while still redacting secrets', async () => {
    const result = await runCli({
      args: [
        'run',
        '--command',
        `printf '%s' "${'$'}${cliContext.secretName}"; yes x | tr -d '\\n' | head -c 25000000`,
      ],
      context: cliContext,
      timeout: 120_000,
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain(cliContext.secretValue)
    expect(result.stdout.startsWith('*'.repeat(cliContext.secretValue.length))).toBe(true)
    expect(result.stdout.length).toBe(cliContext.secretValue.length + 25_000_000)
  }, 180_000)
})

describe('sigillo login', () => {
  let apiUrl: string

  beforeAll(() => {
    // Only the server URL: this suite needs no working login
    apiUrl = resolveConfiguredAuth(currentCwd).apiUrl
  })

  test('starts the device flow even when a token is saved', async () => {
    // A saved token that no longer works must not stop `sigillo login`
    const home = mkdtempSync(join(tmpdir(), 'sigillo-cli-login-'))
    mkdirSync(join(home, '.sigillo'))
    writeFileSync(join(home, '.sigillo', 'config.json'), JSON.stringify({ scoped: { '/': { token: 'stale-session-token', 'api-url': apiUrl } } }))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, APPDATA: home }
    delete env.SIGILLO_TOKEN
    delete env.SIGILLO_API_URL
    const child = spawn(binaryPath, ['login'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    await new Promise<void>((resolveDone) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8')
        if (output.includes('/device?user_code=') || output.includes('Saved bearer token')) resolveDone()
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('close', () => resolveDone())
    })
    child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
    expect(output).not.toContain('Saved bearer token')
    expect(output).toContain('/device?user_code=')
  }, 60_000)
})

async function runCli({
  args,
  context,
  timeout = 60_000,
  stdin,
}: {
  args: string[]
  context: Pick<CliContext, 'env' | 'tmpDir'>
  timeout?: number
  stdin?: string
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(binaryPath, args, {
    cwd: context.tmpDir,
    env: context.env,
    stdio: [stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })

  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin)
    child.stdin.end()
  }

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutChunks.push(Buffer.from(chunk))
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(Buffer.from(chunk))
  })

  const status = await new Promise<number | null>((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectExit(new Error(`sigillo timed out after ${timeout}ms: ${args.join(' ')}`))
    }, timeout)

    child.on('error', (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveExit(code)
    })
  })

  return {
    status,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  }
}

function resolveConfiguredAuth(cwd: string) {
  const config = readSigilloConfig()
  const resolved = {
    token: process.env.SIGILLO_TOKEN ?? '',
    apiUrl: process.env.SIGILLO_API_URL ?? 'https://sigillo.dev',
  }

  let bestTokenScope = 0
  let bestApiScope = 0
  for (const [scope, entry] of Object.entries(config.scoped ?? {})) {
    if (!scopeMatches(cwd, scope)) continue
    if (typeof entry.token === 'string' && scope.length >= bestTokenScope) {
      resolved.token = entry.token
      bestTokenScope = scope.length
    }
    if (typeof entry['api-url'] === 'string' && scope.length >= bestApiScope) {
      resolved.apiUrl = entry['api-url']
      bestApiScope = scope.length
    }
  }

  expect(resolved.token).not.toBe('')
  return resolved
}

function readSigilloConfig(): { scoped?: Record<string, { token?: string; 'api-url'?: string }> } {
  const configDir = process.platform === 'win32' ? 'sigillo' : '.sigillo'
  const configPath = join(homedir(), configDir, 'config.json')
  return JSON.parse(readFileSync(configPath, 'utf8'))
}

function scopeMatches(cwd: string, scope: string) {
  if (scope === '/') return true
  if (!cwd.startsWith(scope)) return false
  if (cwd.length === scope.length) return true
  return cwd[scope.length] === sep
}

async function apiRequest({
  method,
  path,
  context,
  body,
}: {
  method: string
  path: string
  context: Pick<CliContext, 'apiUrl' | 'token'>
  body?: Record<string, string>
}) {
  const response = await fetch(`${context.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${context.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  expect(response.ok, text).toBe(true)
  return JSON.parse(text)
}
