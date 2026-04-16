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

Secrets are AES-256-GCM encrypted in the `SecretsStore` DO. If `ENCRYPTION_KEY` is set, the app uses it directly. Otherwise it derives a stable 32-byte AES key from `BETTER_AUTH_SECRET`. Each secret gets a random 12-byte IV.

Generate a valid `ENCRYPTION_KEY` (32 random bytes, base64-encoded):

```bash
openssl rand -base64 32
```

Set it as a Cloudflare secret for production if you want a separate encryption key:

```bash
echo "$(openssl rand -base64 32)" | wrangler secret put ENCRYPTION_KEY
```

For local dev, add it to `app/.dev.vars` only if you want to override the default derived key:

```
ENCRYPTION_KEY=<output of openssl rand -base64 32>
```

The value must be valid base64 — `atob()` is used to decode it at runtime. If `ENCRYPTION_KEY` is omitted, the app hashes `BETTER_AUTH_SECRET` with SHA-256 and uses that 32-byte digest as the AES key.

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

## CLI

The Sigillo CLI lives in `cli/` and is implemented in Zig as a standalone
binary.

Files to know:

- `cli/zig/src/main.zig` — command wiring and process execution
- `cli/zig/src/client.zig` — HTTP client for the app API
- `cli/zig/src/config.zig` — global scoped config in `~/.sigillo/config.json`
- `app/src/api.ts` — server endpoints the CLI talks to

Command and UX design should stay close to Doppler where it makes Sigillo
simpler to use. Use these as the reference when deciding which commands to add
or how flags and behavior should work:

- Doppler CLI source: https://github.com/DopplerHQ/cli
- Doppler CLI docs: https://docs.doppler.com/docs/cli
- Doppler API reference: https://docs.doppler.com/reference

When implementing new CLI commands, prefer the smallest useful subset of the
Doppler UX rather than inventing a new interface.

## CLI development process

- Prefer editing the Zig CLI directly in `cli/`.
- Use `zig build` and `zig build test` for local validation.
- Keep command implementations simple and short-lived.
- Prefer arenas backed by a general allocator for command-scoped memory.
- Allocate at command start, free at command end, and avoid complex per-value
  lifetime management when a command-scoped arena is enough.
- If command parsing behavior needs to change, check `zeke` first before adding
  local workarounds in Sigillo.

## better auth

if needed download source code from https://github.com/better-auth/better-auth to read how it works

read docs at https://better-auth.com/llms.txt. that page is only an index, you must fetch related pages to read their content

## Publishing

**NEVER run `npm publish`, `pnpm publish`, or any publish command locally.**
Local builds only produce macOS binaries. The published package must include
Linux and Windows binaries too, which require building on actual runners for
those platforms. Only CI can produce a correct release.

To release:

1. Bump the version in `cli/package.json`
2. Update `cli/CHANGELOG.md` with the new version and changes
3. Commit and push to `main`
4. GitHub Actions CI (`cli-ci.yml`) builds all artifacts and publishes
5. CI auto-creates the GitHub release at tag `sigillo@x.y.z` and uploads
   platform archives. You do NOT need to create the release manually.

CI builds standalone executables per platform (macOS arm64/x64, Linux
arm64/x64 musl, Windows arm64/x64) from a single Linux runner using Zig
cross-compilation. On version bump the publish job:

1. Publishes the npm package (with binaries for all platforms in `dist/`)
2. Creates the GitHub release at tag `sigillo@x.y.z`
3. Uploads platform tarballs/zips to the release

Never rely on CI to write the final GitHub release notes. CI can create the
release and upload assets, but after CI is green the agent handling the
release must update the release body manually with the actual user-facing
changelog for that version as a polished markdown list, with real CLI
examples, code blocks, and nicely formatted highlights so users can understand
the release without leaving the release page.

The CI publish job checks whether the version is already on npm and skips if
so. This means you can push multiple commits to `main` and only the version
bump commit triggers an actual publish.

**After pushing a version bump, ALWAYS watch CI to confirm it publishes
successfully:**

```bash
gh run watch --exit-status
```

Report the result to the user. Do not consider the release done until CI
is green and the publish step has completed.
