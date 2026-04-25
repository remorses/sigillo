sigillo is still in pre release. ignore backwards compatibility, instead focus on making code as simple as possible

# Sigillo

Self-hostable secret manager (Doppler/Infisical alternative) running on Cloudflare Workers + D1.

## Architecture

Two Cloudflare Workers in a pnpm monorepo, each backed by a D1 database:

- **`provider`** — Centralized OAuth/OIDC provider at `auth.sigillo.dev`. Wraps Google login via BetterAuth's `oauthProvider` plugin. Self-hosted instances register here automatically via RFC 7591 dynamic client registration as public PKCE clients (no client_secret needed).
- **`app`** — The secret manager users self-host. Authenticates via the provider using `genericOAuth` + PKCE. Encrypts secrets with AES-256-GCM (Web Crypto). Supports RFC 8628 device flow for CLI/agent login.
- **`db`** — Shared Drizzle schemas and migrations for the app's D1 database.

Each worker uses `drizzle-orm/d1` directly — no Durable Objects or proxy layers. The drizzle client is created via `drizzle(env.DB)` in the worker.

## Stack

- **Spiceflow** — API routes + React Server Components
- **BetterAuth** — Auth on both sides (provider + client)
- **Drizzle ORM** — D1 driver, migrations via drizzle-kit + `wrangler d1 migrations apply`
- **Cloudflare Workers + D1** — compute + storage
- **pnpm** workspaces

## CSS and theming

`app/src/globals.css` is the single source of truth for all CSS custom properties (colors, radius, fonts). The provider imports it via `@import 'sigillo-app/src/globals.css'` — never duplicate color definitions across workers.

Rules:
- Never duplicate a CSS variable value. If `--ring` should match `--primary`, write `--ring: var(--primary)`, not the same `color-mix(...)` expression twice.
- When adding a new token that derives from an existing one, always reference it with `var()`.
- Provider-specific styles go in `provider/src/globals.css` after the app import, not as copied theme blocks.

## Secrets encryption

Secrets are AES-256-GCM encrypted in the worker. If `ENCRYPTION_KEY` is set, the app uses it directly. Otherwise it derives a stable 32-byte AES key from `BETTER_AUTH_SECRET`. Each secret gets a random 12-byte IV.

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

- **`cloudflare-workers`** — wrangler.jsonc config, type-safe env, deploy scripts, preview/production environments
- **`drizzle`** — schema conventions, namespace imports, query API, migrations, D1 driver setup
- **`spiceflow`** — API routes + React Server Components framework (fetch latest README every time)

## Deployments

**Always deploy preview first, then production.** Never go straight to production.

Deployment sequence:

```bash
# 1. Deploy preview (runs migration + build + deploy)
pnpm --dir app deployment:preview
pnpm --dir provider deployment:preview

# 2. Verify preview works (load the page, hit /api/health, check logs)

# 3. Deploy production (runs migration + build + deploy)
pnpm --dir app deployment
pnpm --dir provider deployment
```

If the preview migration or deploy fails, **stop**. Do not continue to production. Investigate the error, fix the migration, and retry preview first.

Rules:

- Use script names with `deployment` instead of `deploy` to avoid pnpm's built-in `pnpm deploy` command confusion.
- Use `deployment` for production and `deployment:preview` for preview-only deploys.
- The `deployment` and `deployment:preview` scripts run the D1 migration before building and deploying. If migration fails, the `&&` chain stops and the deploy never happens.
- After deploying preview, always verify it works before proceeding to production.

## Local dev and first-time setup

Local `pnpm dev` needs local D1 schema first. `vite dev` does **not** create tables by itself.

Rules:

- `app/package.json` and `provider/package.json` should keep `dev` scripts that run `wrangler d1 migrations apply DB --local` before starting Vite. `pnpm dev` should work on a fresh checkout without manual migration commands.
- App migrations live in `db/drizzle-app/` and are applied by `app/wrangler.jsonc` via `migrations_dir: ../db/drizzle-app`.
- Provider migrations live in `provider/drizzle/` and are applied by `provider/wrangler.jsonc` via `migrations_dir: ./drizzle`.
- After changing any schema or migration path, validate local boot again with `pnpm --dir app dev -- --port 5188` and `pnpm --dir provider dev`.

First-time local setup:

1. `pnpm install`
2. Create `app/.dev.vars` with at least `BETTER_AUTH_SECRET` and optionally `ENCRYPTION_KEY`
3. Create `provider/.dev.vars` with `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET`
4. Run `pnpm --dir provider dev` once so local provider D1 is created and migrated
5. Run `pnpm --dir app dev -- --port 5188` (or just `pnpm --dir app dev`) so local app D1 is created and migrated

Useful manual commands:

```bash
pnpm --dir provider db:migrate:local
pnpm --dir app db:migrate:local
```

If local dev crashes with `no such table`, assume the local D1 migrations were not applied to that worker's local database yet.

## D1 migrations (remote)

After generating a new migration with `pnpm --dir db run generate`, you must **flatten** the output. Drizzle-kit generates `<timestamp>_<name>/migration.sql` subdirectories, but wrangler D1 only recognizes flat `.sql` files in the migrations dir. Copy the generated `migration.sql` out as a numbered flat file:

```bash
# Example: drizzle-kit generated db/drizzle-app/20260422093421_curved_sauron/migration.sql
cp db/drizzle-app/20260422093421_curved_sauron/migration.sql db/drizzle-app/0003_descriptive-name.sql
```

Use sequential numbering (`0001_`, `0002_`, ...) matching the existing files. Keep the subdirectories around for drizzle-kit's snapshot tracking.

The `db/generate` and provider `db:generate` scripts already run the flatten step automatically via `db/scripts/flatten-migrations.ts`. You can also run it manually:

```bash
# Flatten app migrations
pnpm --dir db run flatten

# Flatten provider migrations
pnpm --dir db run flatten -- ../provider/drizzle
```

The flatten script accepts a directory argument. When called via `pnpm --dir db run flatten -- <path>`, the path overrides the default `./drizzle-app`.

Then apply to remote D1 databases:

```bash
# App — production
pnpm --dir app exec wrangler d1 migrations apply DB --remote

# App — preview
pnpm --dir app exec wrangler d1 migrations apply DB --remote --env preview

# Provider — production
pnpm --dir provider exec wrangler d1 migrations apply DB --remote

# Provider — preview
pnpm --dir provider exec wrangler d1 migrations apply DB --remote --env preview
```

Wrangler tracks applied migrations in a `d1_migrations` metadata table inside each D1 database, so it only runs new ones. The `deployment` and `deployment:preview` scripts now run migrations automatically before building, so you rarely need these manual commands. Use them only for one-off migration testing without redeploying.

Provider migrations are generated separately via `drizzle-kit generate --config drizzle.provider.config.ts` (if it exists) or manually placed in `provider/drizzle/`.

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
- Use `pnpm --dir cli build` to validate CLI changes. It runs the TypeScript wrapper build and refreshes the local `sigillo` command to the current checkout.
- Use `zig build` and `zig build test` when you specifically need to validate the native Zig side directly.
- Keep command implementations simple and short-lived.
- Prefer arenas backed by a general allocator for command-scoped memory.
- Never use `std.heap.page_allocator` in the CLI. Prefer a command-scoped or function-scoped `GeneralPurposeAllocator`, and use an `ArenaAllocator` on top when the lifetime is naturally whole-command.
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
