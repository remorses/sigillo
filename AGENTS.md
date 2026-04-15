sigillo is still in pre release. ignore backwards compatibility, instead focus on making code as simple as possible

# Sigillo

Self-hostable secret manager (Doppler/Infisical alternative) running entirely on Cloudflare Workers + Durable Objects. No external database needed — everything lives in DO SQLite.

## Architecture

Two Cloudflare Workers in a pnpm monorepo:

- **`provider`** — Centralized OAuth/OIDC provider at `auth.sigillo.dev`. Wraps Google login via BetterAuth's `oauthProvider` plugin. Self-hosted instances register here automatically via RFC 7591 dynamic client registration as public PKCE clients (no client_secret needed).
- **`app`** — The secret manager users self-host. Authenticates via the provider using `genericOAuth` + PKCE. Encrypts secrets with AES-256-GCM (Web Crypto). Supports RFC 8628 device flow for CLI/agent login.
- **`db`** — Shared Drizzle schemas and migrations for both DOs.

Each worker has a single Durable Object (`AuthStore` / `SecretsStore`) that holds all state in SQLite via drizzle durable-sqlite.

## Stack

- **Spiceflow** — API routes + React Server Components
- **BetterAuth** — Auth on both sides (provider + client)
- **Drizzle ORM** — durable-sqlite driver, migrations via drizzle-kit
- **Cloudflare Workers + Durable Objects** — compute + storage
- **pnpm** workspaces

## Secrets encryption

Secrets are AES-256-GCM encrypted in the `SecretsStore` DO. The encryption key is a Cloudflare secret (`ENCRYPTION_KEY`), never stored in the DB. Each secret gets a random 12-byte IV.

Generate a valid `ENCRYPTION_KEY` (32 random bytes, base64-encoded):

```bash
openssl rand -base64 32
```

Set it as a Cloudflare secret for production:

```bash
echo "$(openssl rand -base64 32)" | wrangler secret put ENCRYPTION_KEY
```

For local dev, add it to `app/.dev.vars`:

```
ENCRYPTION_KEY=<output of openssl rand -base64 32>
```

The value must be valid base64 — `atob()` is used to decode it at runtime. If it's malformed or missing, all encrypt/decrypt operations fail silently (the server action throws but the error was not visible until we added ErrorBoundary).

## Auth flow

1. Self-hosted app calls `POST /api/setup` on first deploy → registers with provider via dynamic client registration
2. User clicks login → redirected to provider → signs in with Google → consent → redirected back with auth code
3. App exchanges code for tokens via PKCE (no client_secret)
4. CLI/agents use device flow: `POST /api/auth/device/code` → user enters code at `/device` → agent polls for token

## Skills to load

Always load these skills before working on this project:

- **`cloudflare-workers`** — wrangler.jsonc config, type-safe env, Durable Objects, deploy scripts, preview/production environments
- **`drizzle`** — schema conventions, namespace imports, query API, migrations, durable-sqlite driver setup
- **`spiceflow`** — API routes + React Server Components framework (fetch latest README every time)


## REST API reference

The `app/src/api.ts` file contains the external REST API (for CLI, SDKs, agents). It's a separate Spiceflow sub-app mounted in `app/src/app.tsx` via `.use(apiApp)`.

Doppler API reference for design comparison: https://docs.doppler.com/reference

## better auth

if needed download source code from https://github.com/better-auth/better-auth to read how it works

read docs at https://better-auth.com/llms.txt. that page is only an index, you must fetch related pages to read their content

## Publishing

**NEVER publish the CLI from a local machine.** Do not run local release or
publish commands for the Sigillo CLI. Local builds are only for development and
validation.

CLI releases must be produced by CI so every platform build is created in a
clean environment and attached to the GitHub release consistently.

Rules:

- Never do local binary publishing by hand.
- Let GitHub Actions build release binaries for all supported targets.
- Published binaries should be attached to the GitHub release, not just left as
  local files or ad-hoc workflow artifacts.
- When updating release automation, prefer CI-driven release creation/upload and
  keep the local workflow limited to `zig build`, tests, and smoke checks.
