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

## Domain auto-join for organizations

Organizations can enable automatic member join by email domain. When enabled, any user with a **verified** email matching the org's domain (e.g. `@acme.com`) is silently added as a member on their next `/dash/*` page load.

Key files:
- `db/src/app-schema.ts` — `org.autoJoinDomain` column (nullable text, indexed)
- `app/src/lib/utils.ts` — `COMMON_EMAIL_DOMAINS` blocklist + `getEmailDomain()` (client-safe, no server imports)
- `app/src/db.ts` — `autoJoinOrgsByDomain()` runs in the `/dash/*` loader
- `app/src/actions.ts` — `createOrgAction` accepts `enableAutoJoin`, `updateAutoJoinDomainAction` for settings
- `app/src/components/create-org-form.tsx` — checkbox (hidden for public email domains like gmail.com)
- `app/src/components/settings-page.tsx` — enable/disable toggle for admins

Rules:
- `COMMON_EMAIL_DOMAINS` and `getEmailDomain()` live in `lib/utils.ts`, not `db.ts`. Client components import them directly; `db.ts` re-exports them for server code. Never move them to a server-only module.
- Auto-join requires `emailVerified: true` on the user **and** on the admin who enables it. Both `createOrgAction` and `updateAutoJoinDomainAction` check this.
- The auto-join function uses `onConflictDoNothing` on the `(org_id, user_id)` unique index, so it's idempotent and safe to run on every page load.
- No domain ownership verification (DNS, Admin SDK). First user to claim a domain gets it. This is acceptable for a self-hosted tool.
- The blocklist is a UX guard, not a security boundary. It hides the checkbox for gmail.com, outlook.com, etc. to prevent accidental misuse.

## Skills to load

Always load these skills before working on this project:

- **`cloudflare-workers`** — wrangler.jsonc config, type-safe env, deploy scripts, preview/production environments
- **`drizzle`** — schema conventions, namespace imports, query API, migrations, D1 driver setup
- **`spiceflow`** — API routes + React Server Components framework (fetch latest README every time)
- **`strada`** — observability (errors, traces, logs). Load when debugging production issues or touching error handling code

## Observability (Strada)

The app worker reports to Strada project `sigillo-prod` (org Personal). Query with `strada issues list`, `strada logs`, `strada query` — the folder scope is already configured, no `-p` flag needed.

How it's wired (all in `app/`):
- `wrangler.jsonc` — `STRADA_PROJECT_ID` + `STRADA_ENVIRONMENT` vars (production/preview), `STRADA_TOKEN` required secret
- `src/app.tsx` — `initStrada()` in the default fetch handler + `trace.getTracer('sigillo-app')` passed to the Spiceflow constructor for request/route spans
- `src/components/strada-browser.tsx` — browser telemetry (pageviews, uncaught + React render errors)
- `vite.config.ts` — `stradaVitePlugin()` tags browser telemetry with git commit/branch

Rules:
- **Self-hosted instances must never send telemetry.** The same vite build output ships in the self-host bundle, so the browser project id is passed at request time from `env.STRADA_PROJECT_ID` (server prop), never inlined at build time via a public env var. Server init is gated on the same binding. Self-hosted workers have no `STRADA_*` bindings → zero telemetry.
- **All inline-handled errors must call `captureException` from `@strada.sh/sdk`** instead of being swallowed with `console.error`/`console.warn`. This applies to any handler that catches an error and returns a response instead of rethrowing (webhooks, device flow polling, background work). Always pass `tags` with at least a `route` or `handler` identifier.
- **Do not add `captureException` around errors you rethrow.** Spiceflow's instrumentation already calls `span.recordException()` on any error that escapes a route or server action (see `recordError` in `spiceflow/dist/instrumentation.js`), and it deliberately ignores thrown `Response` objects. Capturing manually before rethrowing double-reports the same error.
- **Never swallow an unexpected error to produce an authorization outcome.** `requireApiOrgMember` / `requirePageOrgMember` in `src/db.ts` only catch `ForbiddenError`; anything else rethrows. A bare `catch {}` there used to turn D1 outages into a bogus 403/redirect, which is invisible in Strada and misleading to users.
- **Client components must not statically import `@strada.sh/sdk`.** It pulls the OTel browser runtime into the main client chunk for every visitor, including self-hosters who never initialize it. `strada-browser.tsx` is reached via `await import()` from a server component, so it stays a lazy chunk; do the same (`const { captureException } = await import('@strada.sh/sdk')`) inside browser error paths.
- Use `getLogger()` from `@strada.sh/sdk` for logs that should be queryable, not `console.*`.
- `drizzle-orm` has an optional peer on `@opentelemetry/api`. It's declared as a direct dependency in `db/` and `provider/` so every workspace package resolves the same drizzle instance (otherwise pnpm splits it into two peer-variants and cross-package drizzle types break).

## better-auth version alignment (never use `latest`)

`better-auth` and `@better-auth/oauth-provider` are published from the same repo and **must stay on the same release line**. `provider/package.json` pins the plugin to an exact version (`1.7.6`) on purpose:

```json
"@better-auth/oauth-provider": "1.7.6",
"better-auth": "^1.7.6",
```

`@better-auth/oauth-provider` used to be `"latest"`, which silently floated onto the **stable 1.6.x line** while `better-auth` stayed on `1.7.0-beta`. That mismatch produced two separate failures that look unrelated but share one cause:

| Symptom | Where |
|---|---|
| `"dispatchAuthEndpoint" is not exported by better-auth/api` | `pnpm --dir provider build` |
| `TS2883: ... cannot be named without a reference to 'MiddlewareInputContext' from better-call` | `pnpm --dir provider typecheck` |
| `TS2339: Property 'oauth2' does not exist on type ...` | `consent-buttons.tsx` |
| a wall of `@better-fetch/fetch@1.1.21` vs `@1.3.1` `ResponseContext` errors | `pnpm --dir provider typecheck` |

The two release lines pin **different exact versions** of `@better-fetch/fetch`, `better-call`, and `@better-auth/utils`, so pnpm installed both copies and the duplicate types stopped unifying. A previous attempt papered over this with `pnpm.overrides` forcing the newer trio; that only masked the symptom and left `better-auth` running against transitive deps it does not pin. Aligning the release lines removed the need for any override.

Rules:
- Never use `latest` or a floating range for `@better-auth/oauth-provider`. Pin it exactly.
- When bumping `better-auth`, bump `@better-auth/oauth-provider` to the **same version string** in the same commit.
- After any better-auth change run both `pnpm --dir provider typecheck` and `pnpm --dir provider build`. Typecheck alone does not catch the missing-export failure.
- If duplicate peer variants reappear (e.g. two `jose` copies causing `TS2883`), run `pnpm dedupe` before reaching for `pnpm.overrides`.

The remaining `unmet peer drizzle-orm@^0.45.2: found 1.0.0-rc.1` warning from `pnpm install` is expected — the app intentionally runs drizzle 1.0 rc.

## better-auth `string[]` and `json` columns MUST be drizzle json mode

The provider uses `better-auth-drizzle-adapter` (a fork of better-auth#9489), not the stock `better-auth/adapters/drizzle`. Since `1.2.0` its adapter config is byte-identical to upstream's **relations-v2** entrypoint:

```ts
supportsJSON: true,
supportsArrays: true,
```

Both flags being `true` means **drizzle owns JSON serialization**, not better-auth. The factory only encodes when a flag is `false`:

```ts
transformInput:  supportsJSON   === false && typeof v === 'object' && type === 'json'      -> JSON.stringify(v)
transformInput:  supportsArrays === false && Array.isArray(v)                              -> JSON.stringify(v)
transformOutput: supportsJSON   === false && typeof v === 'string' && type === 'json'      -> JSON.parse(v)
transformOutput: supportsArrays === false && typeof v === 'string'                         -> JSON.parse(v)
```

So every field better-auth types as `string[]`, `number[]` or `json` must be declared as `text(name, { mode: 'json' })`. A plain `text()` silently breaks both directions, and the two failures look unrelated:

| direction | symptom |
|---|---|
| insert | `D1_TYPE_ERROR: Type 'object' not supported for value '...'` on `/oauth2/register` |
| select | `TypeError: registered.find is not a function` in `findRegisteredRedirectUri` → `/oauth2/authorize` 500s and **every login dies at the provider** |

Beware the **stock** adapter (`@better-auth/drizzle-adapter`, the default export) sets both flags to `provider === 'pg'`, which is the opposite contract: it wants plain `text()` columns. Pointing this schema at it would double-encode every one of these fields. That mismatch is a live upstream bug (better-auth#8655, #8107, #7440 — all open, its own CLI generator emits json-mode columns), so do not "fix" the fork by switching to the stock adapter.

Rules:

- Use the `jsonArray()` helper in `provider/src/schema.ts` for `string[]` fields; it keeps the TS type as `string[]`.
- `string[]` columns have the same on-disk bytes either way (TEXT holding single-encoded JSON), so flipping one to `{ mode: 'json' }` needs **no data migration**. `json` columns do not: before adapter `1.2.0` they were double-encoded as `"{\"a\":1}"`, and pre-1.2.0 rows now decode to a **string** instead of an object. `oauthClient.metadata` is the only `json` column here and is always NULL, because the oauth-provider plugin only fills it from unrecognized registration fields and `ensureOAuthClient` sends just the standard RFC 7591 keys.
- After bumping `better-auth` or `@better-auth/oauth-provider`, diff the drizzle schema against the plugin schema. `getAuthTables({ plugins: [...] })` from `better-auth/db` gives the authoritative field list; compare it with `getTableColumns()` to catch both missing columns and wrong column modes. Any column whose drizzle `dataType` is not `object json` while better-auth types it `string[]`/`number[]`/`json` is a bug. 1.7 added `oauth_client.jwks`, `oauth_client.jwks_uri`, `resources` on the consent/token tables, and `jwks.expires_at`. 1.7.6 added 19 more columns and the `oauth_resource`, `oauth_client_resource` and `oauth_client_assertion` tables (provider migration `0003`).
- Typecheck and build both pass with the wrong mode. Only a real request against D1 catches it, so exercise `/oauth2/register` plus `/oauth2/authorize` locally after any schema or adapter change.

## Direct `auth.api.oauth2*` calls need `request` AND `asResponse: false`

The provider auto-accepts consent server-side for our own app instead of rendering a consent screen, so `/consent` and `/select-account` call `auth.api.oauth2Consent` / `auth.api.oauth2Continue` directly rather than going through the browser `authClient`. Both endpoints finish by calling the plugin's internal `authorizeEndpoint`, which opens with:

```js
if (!ctx.request) throw new APIError('UNAUTHORIZED', {
  error_description: 'request not found', error: 'invalid_request',
})
```

better-call sets `ctx.request` **only** from an explicit `request` option (`better-call/dist/context.mjs`); it never derives it from `headers`. Over HTTP the router fills it in, which is why every upstream example (`authClient.oauth2.consent()`) works and this one did not. The correct call is:

```ts
const result = await auth.api.oauth2Consent({
  body: { accept: true, oauth_query: url.search.slice(1) },
  headers: request.headers, // session lookup reads ctx.headers, not ctx.request
  request,                  // satisfies authorizeEndpoint's !ctx.request guard
  asResponse: false,        // see below — not optional
})
```

| Field | Why it is required |
|---|---|
| `headers` | `sessionMiddleware` → `getSessionFromCtx` reads `ctx.headers`. Drop it and there is no session. |
| `request` | `authorizeEndpoint`'s guard. Drop it and login dies with a raw JSON `APIError` blob on the consent page. |
| `asResponse: false` | `toAuthEndpoints` does `shouldReturnResponse = context?.asResponse ?? isRequestLike(context?.request)`. Adding `request` alone flips the return value from `{ redirect, url }` to a `Response`, so `result.url` becomes `""` and you redirect to nowhere. |

Rules:

- Never add `request` to a direct `auth.api.*` call without also passing `asResponse: false`, unless you actually want the `Response`.
- **TypeScript does not catch either mistake.** better-call's `StrictEndpoint` overloads pick the return type from the literal presence of `asResponse`, so the declared type stays `{ redirect: true; url: string }` either way. Typecheck, build, lint, and the app test suite all passed with the broken call.
- The only thing that catches this is a real OAuth round trip. After touching `provider/src/app.tsx`, log in end to end against preview with cleared cookies.
- The first-party check in `/consent` derives its host from `env.BETTER_AUTH_URL` (`auth.sigillo.dev` → `sigillo.dev`, `auth.preview.sigillo.dev` → `preview.sigillo.dev`). It used to be the hardcoded literal `'sigillo.dev'`, which made the auto-accept branch **unreachable on preview** — the bug above could only ever surface in production. Keep it derived so preview exercises the same path.

## Sign-out is federated, and login always asks which Google account

Two sessions exist per user: one on the app (`sigillo.dev`) and one on the provider (`auth.sigillo.dev`). Clearing only the app one made "Log out" a lie — the next click on **Sign in with Google** went `authorize → /consent` (auto-accepted for first-party) → back into the app as the same user, without ever reaching Google. Switching Google accounts was impossible, and on a shared machine the next person inherited the session.

The flow now spans both workers:

```
┌──────────────────────────┐                      ┌────────────────────────────┐
│  sigillo.dev             │                      │  auth.sigillo.dev          │
│                          │   302 client_id +    │                            │
│  GET /logout             ├─────────────────────>│  GET /sign-out             │
│  ├ clears app session    │   post_logout_redir  │  ├ validates redirect uri  │
│  └ 302 to provider       │<─────────────────────┤  └ clears provider session │
│                          │   302 back to /login │                            │
└──────────────────────────┘                      └────────────────────────────┘
```

Rules:

- **Log out must be a full navigation to `/logout`, never `authClient.signOut()` in the browser.** The second half is a cross-origin redirect the browser has to follow so the provider can send its own expired `Set-Cookie`. A client-side `signOut()` can only reach the app's own origin.
- **`post_logout_redirect_uri` is validated against the calling client's registered `redirect_uris` (same origin).** `/sign-out` lives on the domain holding everyone's SSO session, so an unvalidated redirect there is a phishing primitive. `client_id` is required for that lookup; without it, or on any mismatch, it falls back to the provider root.
- This deliberately does **not** use the plugin's RFC-compliant `/oauth2/end-session`. That needs an `id_token_hint`, a client with `enable_end_session`, and pre-registered `post_logout_redirect_uris`. Clients here register dynamically at first boot and `genericOAuth` does not retain the id_token, so every existing client would need re-registration for no extra safety.
- `auth.api.signOut` throws `BAD_REQUEST` when no session cookie is present, so both routes check for a session first. Landing on `/logout` while already signed out is normal and must still redirect.

The app also sets `prompt: 'select_account'` on its `genericOAuth` config, so pressing **Sign in with Google** always shows Google's account picker even when the provider session survived (expired app cookie, cleared app storage). The provider maps that onto `selectAccount.page` → `/select-account`.

**`/sign-in` must strip `select_account` from the authorize query it resumes.** Reaching `/sign-in` at all means the user just came back through Google's picker, so the prompt is already satisfied. Leaving it in made authorize see `session + prompt=select_account`, bounce to `/select-account`, and send the user to the picker a **second time** before completing. Not an infinite loop, just two identical pickers back to back. `removePrompt()` in `provider/src/app.tsx` does this; it is safe despite the query being signed (`sig` + `exp`), because the signature is only verified when the query is replayed as `oauth_query` on `/oauth2/consent` or `/oauth2/continue` — a plain GET to `/oauth2/authorize` is treated as a fresh request and never checks it.

There are two distinct login paths and **both need a real browser round trip to verify**; nothing in typecheck, build, or the test suite exercises them:

| provider session | path | expected |
|---|---|---|
| absent | `authorize → /sign-in → Google → /sign-in → authorize → app callback` | one picker |
| alive | `authorize → /select-account → Google → /select-account?selected=1 → /oauth2/continue → app callback` | one picker |

`/select-account` had never run in production before this change (`shouldRedirect` returns false and no client sent the prompt), so treat it as the fragile path when touching this code.

## packageExtensions for safe-mdx

`safe-mdx` imports `react-dom` (`prefetchDNS`, `preconnect`) but only declares `react` as a peer dependency, so pnpm builds a react-only variant and Vite fails to load the config with `Cannot find package 'react-dom'`. The root `package.json` corrects the metadata locally:

```json
"packageExtensions": {
  "safe-mdx": { "peerDependencies": { "react-dom": "*" } }
}
```

The real fix belongs upstream in https://github.com/holocron-hq/safe-mdx — remove this once the peer is declared there.

## spiceflow must be a single instance

`@holocron.so/vite` pins an **exact** spiceflow version. `app/package.json` and `provider/package.json` must pin the **same** exact version or the vite plugin throws `assertSingleSpiceflowInstance`. When bumping holocron, check its pinned spiceflow version and match it:

```bash
rg '"spiceflow"' node_modules/.pnpm/@holocron.so+vite@*/node_modules/@holocron.so/vite/package.json
```

## blake3-wasm is pinned to match wrangler

`app/package.json` pins `blake3-wasm` to `2.1.5` with no caret. `scripts/build-selfhost-bundle.ts` precomputes asset hashes with the same algorithm wrangler uses, so the version must match wrangler's own `blake3-wasm` dependency exactly or the self-host asset manifest will not match what the Cloudflare API expects. Do not bump it independently; check `node_modules/.pnpm/wrangler@*/node_modules/wrangler/package.json` first.

## Deployments

**Always deploy preview first, then production.** Never go straight to production.

Deployment sequence:

```bash
# 1. Deploy preview (runs migration + build + deploy)
pnpm --dir app deployment
pnpm --dir provider deployment

# 2. Verify preview works (load the page, hit /api/health, check logs)

# 3. Deploy production (runs migration + build + deploy)
pnpm --dir app deployment:prod
pnpm --dir provider deployment:prod
```

If the preview migration or deploy fails, **stop**. Do not continue to production. Investigate the error, fix the migration, and retry preview first.

Rules:

- Use script names with `deployment` instead of `deploy` to avoid pnpm's built-in `pnpm deploy` command confusion.
- Use `deployment` for preview by default and `deployment:prod` for production deploys.
- The `deployment` and `deployment:prod` scripts run the D1 migration before building and deploying. If migration fails, the `&&` chain stops and the deploy never happens.
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

## Tests

`pnpm --dir app test` runs the integration suite inside workerd via `@cloudflare/vitest-pool-workers`, against real D1, real Cache API, and real AES-256-GCM. The whole suite should finish in **under 15 seconds**. If it takes minutes, something is hanging, not working hard.

### Outbound HTTP must be answered locally

`app/vite.config.ts` installs a miniflare `outboundService` (`testOutboundService`) that intercepts **every** outbound fetch from the worker under test and returns a 501 for anything it does not recognize.

This is not a nicety. betterAuth's `genericOAuth` plugin resolves `discoveryUrl` during plugin init and **awaits** it before any auth endpoint runs. `wrangler.test.jsonc` sets `PROVIDER_URL` to `https://provider.invalid`, and in workerd a fetch to an unresolvable host **never settles** — it neither resolves nor rejects. Every test that called `auth.api.*` (i.e. every test that created a user) silently timed out at 5s, and the failures surfaced on unrelated-looking tests.

Rules:
- Any new outbound dependency in a code path under test must get a branch in `testOutboundService`. Do not reach for the network.
- `TEST_PROVIDER_ORIGIN` in `vite.config.ts` must match `PROVIDER_URL` in `wrangler.test.jsonc`.
- `fetchMock` from `cloudflare:test` no longer exists — it was removed in `@cloudflare/vitest-pool-workers@0.16`. Use `outboundService`, not a mocking library.
- When a test hangs with no error, check for an unmocked outbound fetch first. Wrapping the suspect call in `Promise.race` with a timeout and logging `globalThis.fetch` calls is the fastest way to find it.

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

Wrangler tracks applied migrations in a `d1_migrations` metadata table inside each D1 database, so it only runs new ones. The `deployment` and `deployment:prod` scripts now run migrations automatically before building, so you rarely need these manual commands. Use them only for one-off migration testing without redeploying.

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
- Use `zig build` and `zig build test` (from `cli/zig`) to validate the native Zig side while iterating. `pnpm --dir cli build` only runs `tsc` for the TypeScript wrapper.
- Keep command implementations simple and short-lived.

### ALWAYS rebuild the global `sigillo` after CLI changes

The global `sigillo` on your PATH (`~/.local/bin/sigillo`) is a wrapper that
execs the prebuilt host binary at `cli/dist/<host>/sigillo`. It does **not**
auto-update when you edit the Zig source. After **every** commit or change to
the CLI, rebuild and reinstall it so the global command reflects the latest
changes:

```bash
pnpm --dir cli install:local
```

This runs `scripts/build.ts`, which builds the host binary into
`cli/dist/<host>/sigillo`, re-signs it on macOS, and refreshes the
`~/.local/bin/sigillo` (and pnpm global) wrappers. Verify with
`sigillo --version`.

macOS note: copying a Mach-O binary invalidates Zig's embedded adhoc code
signature, so an un-resigned copy is SIGKILLed by the kernel (`zsh: killed
sigillo ...`, exit 137). `scripts/build.ts` re-runs `codesign --force --sign -`
on the macOS host binary to prevent this. If you ever see `zsh: killed` from
`sigillo`, re-run `pnpm --dir cli install:local`.
- Prefer arenas backed by a general allocator for command-scoped memory.
- Never use `std.heap.page_allocator` in the CLI. Prefer a command-scoped or function-scoped `GeneralPurposeAllocator`, and use an `ArenaAllocator` on top when the lifetime is naturally whole-command.
- Allocate at command start, free at command end, and avoid complex per-value
  lifetime management when a command-scoped arena is enough.
- If command parsing behavior needs to change, check `zeke` first before adding
  local workarounds in Sigillo.

## better auth

if needed download source code from https://github.com/better-auth/better-auth to read how it works

read docs at https://better-auth.com/llms.txt. that page is only an index, you must fetch related pages to read their content

## Changesets

Always add a `.changeset/*.md` file for user-facing changes. Load the `changesets` skill for format.

Include **`sigillo-app`** (the website at sigillo.dev) even though it is private. Private packages still get a CHANGELOG. Do not skip them.

Include **`sigillo`** when the CLI changes. If both the website and the CLI changed, list both in the same changeset frontmatter.

## Publishing

**NEVER run `npm publish`, `pnpm publish`, or any publish command locally.**
Local builds only produce macOS binaries. The published package must include
Linux and Windows binaries too, which require building on actual runners for
those platforms. Only CI can produce a correct release.

To release:

1. Add a `.changeset/*.md` file describing the changes. Include `sigillo-app` for website changes, not only the CLI
2. Commit and push to `main`
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

**After npm publish succeeds, ALWAYS deploy the website.** The app worker
hosts the public docs at sigillo.dev. CLI docs, install script, and OpenAPI
are generated at app build time, so a published CLI with a stale site is a
broken release. Follow the normal preview-then-production sequence. Do not
skip this even if the version bump was CLI-only.

```bash
pnpm --dir app deployment
# verify preview
pnpm --dir app deployment:prod
```
