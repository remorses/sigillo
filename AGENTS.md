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
