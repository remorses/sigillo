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

## Agent rules

### Never read secret values into context

Never read a secret value into the agent context window or pass it as plain text in a command. Instead, chain commands via stdin/pipes so the value flows directly between processes without being visible.

**Copying a secret from one env to another:**

```bash
# value flows through stdin, never seen by the agent
sigillo secrets get DATABASE_URL -c dev | sigillo secrets set DATABASE_URL -c preview
```

The same pattern works for any secret copy — between environments, or when seeding a new environment from an existing one.

### Never read `.env` files directly

If a `.env` file exists, do not source it or read its contents. Use `sigillo run` instead:

```bash
# exposes secrets to the agent context window
source .env && next dev

# secrets injected, never visible to the agent
sigillo run -- next dev
```

### Directory scoping

`sigillo setup` binds the current directory to a project and environment via `~/.sigillo/config.json`. The CLI resolves config by **longest matching scope** — a deeper directory wins over a parent.

After setup, `sigillo run` in any subdirectory uses that project + environment automatically.

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

### Prefer `sigillo run` over downloading secrets

Avoid `sigillo secrets download` unless a specific tool requires a file. Prefer injecting directly via `sigillo run --` so values never touch the filesystem.

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
https://sigillo.dev/orgs/<ORG_ID>/projects/<PROJECT_ID>/envs/<ENV_SLUG>
```

Always print the actual URLs with real IDs so the user can click them:

```
https://sigillo.dev/orgs/01ABC.../projects/01DEF.../envs/dev
https://sigillo.dev/orgs/01ABC.../projects/01DEF.../envs/preview
https://sigillo.dev/orgs/01ABC.../projects/01DEF.../envs/prod
```

### 7. Verify

```bash
sigillo secrets -c dev
sigillo run -c dev -- pnpm dev
```

