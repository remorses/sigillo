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

### Syncing secrets to deployment platforms

The README has the full commands for syncing to Cloudflare Workers, Vercel, Docker, and others. When setting up a project that deploys to one of these platforms, **add the sync commands as `package.json` scripts** so they're easy to run before each deploy:

```json
{
  "scripts": {
    "secrets:preview": "sigillo run -c preview --mount .env.preview --mount-format env -- wrangler secret bulk --env preview .env.preview",
    "secrets:production": "sigillo run -c production --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod"
  }
}
```

Use the exact commands from the README for each platform — the pattern is always `sigillo run -c <env> --mount <file> -- <platform-cli> <file>`.
