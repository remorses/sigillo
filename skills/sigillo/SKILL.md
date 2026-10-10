---
name: sigillo
description: >
  Sigillo is a self-hostable open-source alternative to Doppler. Use when
  working with sigillo run, sigillo setup, sigillo login, managing secrets,
  projects, or environments. Also load when integrating Sigillo into CI,
  Cloudflare Workers, Docker, Vercel, or any other deployment target.
---

# sigillo

ALWAYS fetch the latest README before doing anything else. NEVER skip this:

```bash
curl -s https://raw.githubusercontent.com/remorses/sigillo/main/README.md
```

**NEVER pipe through `head`, `tail`, `sed -n`, or any truncating command.** Read the full output — agent rules and integration patterns are near the bottom and will be missed if truncated.

ALWAYS also run help to see exact flag names for the installed version (flags can differ between versions):

```bash
sigillo --help
```

**NEVER truncate this either.**

If a flag or command documented here is missing from `--help`, the installed binary is likely outdated. Update before proceeding:

```bash
npm i -g sigillo@latest
```

If sigillo is symlinked to a local dev build (check with `which sigillo`), rebuild from source instead:

```bash
cd /path/to/sigillo/cli && zig build -Dtarget=aarch64-macos
cp zig-out/bin/sigillo dist/darwin-arm64/sigillo
```

## New project setup workflow

This mirrors the Doppler workflow: check auth → link project → list secrets → run.

**1. Check if already logged in:**

```bash
sigillo me
```

Shows current user and organizations. If it errors with "not logged in", run `sigillo login` first.

**2. Login (opens browser device flow):**

```bash
sigillo login
```

For non-interactive/CI environments, save a token directly:

```bash
sigillo login --token sig_xxx --scope .
```

**3. Link the current directory to a project and environment:**

```bash
sigillo setup
```

Interactive — fetches your projects and environments and lets you pick from a list. **Default to `dev` for local development** unless the user specifies otherwise. Non-interactive:

```bash
sigillo setup --project proj_abc --env dev
```

Use `dev` for local work, `preview` for staging, `production` for prod. Only use `preview` or `production` if the user explicitly asks for it.

Run `sigillo --help` to verify the exact flag name (`--env` vs `--environment`) for the installed version.

**4. List secrets to verify the setup is working:**

```bash
sigillo secrets
```

Shows secret names for the configured environment (values are never shown). Example output:

```
environment_id: "env_abc"
secrets:
  - id: "sec_1"
    name: "DATABASE_URL"
  - id: "sec_2"
    name: "API_KEY"
```

To read a specific value:

```bash
sigillo secrets get DATABASE_URL
```

`secrets get` returns YAML by default. Pass `--raw` to output only the raw value (no YAML wrapping). When stdout is piped, `--raw` is implied automatically:

```bash
# copy a secret between environments (piped stdout auto-enables raw mode)
sigillo secrets get DATABASE_URL -c dev | sigillo secrets set DATABASE_URL -c preview

# force raw output in a terminal (useful for scripting)
sigillo secrets get DATABASE_URL --raw
```

**5. Run your app with secrets injected:**

```bash
sigillo run -- next dev
sigillo run -- printenv   # verify which vars are injected (values redacted)
```

`sigillo run` uses the environment saved by `sigillo setup` for the current directory. Override per-command with `-c` or `--env` (check `sigillo --help` for the exact flag name in the installed version):

```bash
sigillo run -c dev -- next dev          # explicitly use dev
sigillo run -c preview -- next build    # use preview
sigillo run -c production -- next build # use production
sigillo secrets get DATABASE_URL -c preview  # override for a single secrets command
```

## Never use `sigillo run` output as secret data

**Redaction changes output.** `sigillo run` replaces matching secret values in stdout and stderr with literal `*` characters by default, even when output is piped. Never pipe its stdout or stderr into another tool to pass a secret value. The tool can receive asterisks instead of the password or token, with no separate notice that the value was replaced.

**Use a direct secret pipe** when a tool needs the value on stdin:

```bash
sigillo secrets get ICLOUD_PASS -c dev --raw | some-tool --stdin
```

Piped `secrets get` output is not redacted and has no added newline. `--raw` makes the intent explicit; piped stdout already enables raw mode automatically. Keep the value in the pipe so it does not enter the agent context.

**Let the child read its environment** when the tool supports it:

```bash
# some-tool reads ICLOUD_PASS from its environment.
sigillo run -c dev -- some-tool
```

Pipes inside a `--command` child shell connect child processes before Sigillo filters their final output. They are different from piping `sigillo run` output into an external tool.

## Self-hosting on Cloudflare

Deploy Sigillo to the user's own Cloudflare account with one command (npm package only, needs Node.js):

```bash
npx sigillo self-host
```

It provisions a Worker + D1 database, applies migrations, and prints the instance URL. Cloudflare auth is resolved automatically: `CLOUDFLARE_API_TOKEN` env → existing `wrangler login` → OAuth browser flow → pre-filled API token creation link (works over SSH). Re-running the command is idempotent and deploys the latest release.

```bash
# non-interactive (agents/CI)
CLOUDFLARE_API_TOKEN=xxx npx sigillo self-host --yes

# custom worker name and custom domain
npx sigillo self-host --name sigillo --domain secrets.acme.com
```

Point the CLI at the deployed instance with `sigillo login --api-url <url>`.

## Agent rules

### Never read secret values into context

Never read a secret value into the agent context window or pass it as plain text in a command. Instead, chain commands via stdin/pipes so the value flows directly between processes without being visible.

**Copying a secret from one env to another:**

```bash
# piped stdout auto-enables raw mode, value never seen by the agent
sigillo secrets get DATABASE_URL -c dev | sigillo secrets set DATABASE_URL -c preview
```

The same pattern works for any secret copy, between environments, or when seeding a new environment from an existing one.

### Never read `.env` files or `~/.sigillo/*`

If a `.env` file exists, do not source it or read its contents. Use `sigillo run` instead:

```bash
# exposes secrets to the agent context window
source .env && next dev

# secrets injected, never visible to the agent
sigillo run -- next dev
```

**Never read any file under `~/.sigillo/` directly** (config.json, tokens, scopes, etc.). That directory contains auth tokens and project bindings. Use `sigillo me` to check current auth status, org, and project setup:

```bash
sigillo me
```

### Put `sigillo run` inside package scripts

If a `package.json` script requires secrets, embed `sigillo run` directly in the script. Do not rely on users or agents remembering to prefix the command manually. The script should choose the correct environment for the target.

```json
{
  "scripts": {
    "dev": "sigillo run -c dev -- vite dev",
    "deploy": "pnpm db:migrate:preview && CLOUDFLARE_ENV=preview sigillo run -c preview --command 'tsc && vite build && wrangler deploy --env preview'",
    "deploy:prod": "pnpm db:migrate:prod && sigillo run -c prod --command 'tsc && vite build && wrangler deploy'"
  }
}
```

These scripts work because pnpm adds `node_modules/.bin` to PATH before executing the script string, and sigillo inherits that PATH. Commands like `tsc`, `vite`, and `wrangler` resolve correctly inside `--command` as long as the entry point is `pnpm run deploy`.

Use `-c dev` for local development, `-c preview` for staging or preview deployments, and `-c prod` or the repo's production slug for production.

### Always run `sigillo run` via pnpm scripts, not directly

`sigillo run --command` spawns `$SHELL -c '...'` and passes the inherited `PATH`. But pnpm only adds `node_modules/.bin` to `PATH` when it's running a `package.json` script. If you call `sigillo run --command 'tsc && vite build'` directly from the terminal, `tsc` and `vite` won't be found because `node_modules/.bin` is not in PATH.

Always invoke deploy/build commands through `pnpm run <script>` so pnpm augments PATH before sigillo inherits it. If you must run sigillo directly, use `pnpm exec` to resolve binaries: `sigillo run --command 'pnpm exec tsc && pnpm exec vite build'`.

### Use `--command` for shell expansion

Use direct argv mode when no shell syntax is needed:

```bash
sigillo run -c preview -- pnpm db:migrate:preview
```

Use `--command` when the command needs shell features such as `&&`, pipes, redirects, inline env vars, or `$VARIABLE` expansion. Wrap the command in single quotes so the parent shell does not expand `$VARIABLE` before Sigillo injects secrets.

```bash
# BAD: the parent shell expands $DATABASE_URL before sigillo runs
sigillo run --command "psql $DATABASE_URL -c 'select 1'"

# GOOD: $DATABASE_URL expands inside sigillo's child shell after secrets are injected
sigillo run --command 'psql $DATABASE_URL -c "select 1"'

# GOOD: put non-secret env vars before sigillo run, then use command mode for the chain
CLOUDFLARE_ENV=preview sigillo run -c preview --command 'vite build && wrangler deploy --env preview'
```

### Directory scoping

`sigillo setup` binds the current directory to a project and environment via `~/.sigillo/config.json`. The CLI resolves config by **longest matching scope** — a deeper directory wins over a parent.

After setup, `sigillo run` in any subdirectory uses that project + environment automatically.

**Git worktrees** inherit the setup of their main checkout at the same relative path. Setup in `~/repo` and `~/repo/app` also applies to `/tmp/feature` and `/tmp/feature/app` when `/tmp/feature` is a worktree of `~/repo`. A setup saved inside the worktree overrides the main checkout for that worktree only.

```bash
# from inside a worktree: configure the main checkout, so every worktree gets it
sigillo setup --scope /path/to/main/checkout --project proj_abc --env dev
```

### CI environment variables

```yaml
- name: Run with secrets
  env:
    SIGILLO_TOKEN: ${{ secrets.SIGILLO_TOKEN }}
    SIGILLO_PROJECT: ${{ vars.SIGILLO_PROJECT }}
    SIGILLO_ENVIRONMENT: production
  run: npx sigillo run -- pnpm build
```

### Redaction details

`sigillo run` replaces secret values in stdout/stderr with `*`. Threshold: **Shannon entropy ≥ 3.5 bits/char AND length ≥ 16 chars** — short values like `true`, `1`, `development` are not redacted.

This also applies to piped output. Follow **Never use `sigillo run` output as secret data** above when passing a secret to another tool.

### Prefer `sigillo run` over downloading secrets

Avoid `sigillo secrets download` unless a specific tool requires a file. Prefer injecting directly via `sigillo run --` so values never touch the filesystem.

`wrangler secret bulk` is a valid exception because it accepts stdin. For
Cloudflare Workers, sync the complete environment directly through a pipe and
do not create `.env.preview` or `.env.prod` files. Read the **Cloudflare
Workers** section of the root README for the canonical package scripts and
explicit production/preview target flags.

## Placeholder secrets (user fills in later)

When the user asks to add a secret but will provide the actual value later via the dashboard, set it with an empty value:

```bash
sigillo secrets set DATABASE_URL ""
```

This creates the secret as a placeholder. The CLI shows `empty: true` when listing secrets so empty placeholders are visible. After setting the placeholder, always print the dashboard URL so the user can fill it in:

```
https://sigillo.dev/dash/projects/<PROJECT_ID>/envs/<ENV_SLUG>
```

Replace `<PROJECT_ID>` and `<ENV_SLUG>` with the actual values from the current setup. To find them:

```bash
sigillo secrets
```

The `environment_id` in the output is the env ID. The project ID is from `sigillo setup` or `sigillo projects`.

To set placeholders across all environments at once:

```bash
sigillo secrets set DATABASE_URL "" -c dev -c preview -c prod
```

For secrets that need real random values immediately (auth secrets, encryption keys), generate them instead of leaving empty:

```bash
sigillo secrets set AUTH_SECRET "$(openssl rand -base64 32)" -c dev -c preview -c prod
```

## Bootstrapping a project for a new codebase

When a codebase needs Sigillo for the first time, the agent creates the org, project, and placeholder secrets. The user fills in real values later via the web UI.

### 1. Check existing orgs

```bash
sigillo me
```

Ask the user if they want to use an existing org or create a new one.

### 2. Create an org (if needed)

```bash
sigillo orgs create --name my-org
```

Run `sigillo me` after to get the new org ID.

### 3. Create a project

```bash
sigillo projects create --org <ORG_ID> --name <project-name>
```

Three default environments are auto-created: `dev`, `preview`, `prod`.

### 4. Link the directory

Run from the directory that will use secrets (usually the app or website folder):

```bash
sigillo setup --project <PROJECT_ID> --env dev
```

### 5. Add placeholder secrets

Set empty values for each secret. The user fills in real values later via the web UI:

```bash
for secret in DATABASE_URL API_KEY AUTH_SECRET; do
  sigillo secrets set "$secret" "" -c dev
  sigillo secrets set "$secret" "" -c preview
  sigillo secrets set "$secret" "" -c prod
done
```

For `BETTER_AUTH_SECRET` or encryption keys, generate a real random value immediately:

```bash
sigillo secrets set BETTER_AUTH_SECRET "$(openssl rand -base64 32)" -c dev
sigillo secrets set BETTER_AUTH_SECRET "$(openssl rand -base64 32)" -c preview
sigillo secrets set BETTER_AUTH_SECRET "$(openssl rand -base64 32)" -c prod
```

### 6. Print the web UI URLs

After setup, tell the user to open the Sigillo web UI to fill in empty secrets. The URL pattern is:

```
https://sigillo.dev/dash/projects/<PROJECT_ID>/envs/<ENV_SLUG>
```

Always print the actual URLs with real IDs so the user can click them:

```
https://sigillo.dev/dash/projects/01DEF.../envs/dev
https://sigillo.dev/dash/projects/01DEF.../envs/preview
https://sigillo.dev/dash/projects/01DEF.../envs/prod
```

### 7. Verify

```bash
sigillo secrets -c dev
sigillo run -c dev -- pnpm dev
```
