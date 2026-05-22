<div align='center' class='hidden'>
    <br/>
    <br/>
    <h3>sigillo</h3>
    <p>Self-hostable secrets manager for humans & agents</p>
    <br/>
    <br/>
</div>

Sigillo replaces `.env` files with a **cloud-based secrets manager** you can self-host. Prefix your commands with `sigillo run` and secrets are injected as environment variables, never written to disk.

```bash
# instead of this
source .env && next dev

# do this
sigillo run -- next dev
```

```diagram
                                                 ┌────────────────┐
  sigillo run -- next dev                        │   App Worker   │
         │                                       │  (sigillo.dev) │
         │  1. fetch secrets                     │                │
         │──────────────────────────────────────▶│  decrypt       │
         │  { DB_URL, API_KEY, ... }             │  AES-256-GCM   │
         │◀──────────────────────────────────────│                │
         │                                       └────────────────┘
         │  2. spawn child with env vars
         │
         ▼
  ┌──────────────┐
  │  next dev    │
  │  (child)     │
  └──────┬───────┘
         │
         │  3. stdout / stderr
         ▼
  ┌───────────────┐
  │   redaction   │  high-entropy values replaced with *
  │    filter     │  secrets never reach your terminal
  └──────┬────────┘
         │
         ▼
     terminal
    (safe output)
```

Secrets are **automatically redacted** from process output so they never leak into agent context windows, CI logs, or terminal history.

**Open-source alternative** to [Doppler](https://doppler.com) and [Infisical](https://infisical.com).

## Why Sigillo?

### Why not Doppler or Infisical?

- **Self-hosted**: runs on your own Cloudflare account. No centralized point of failure, no vendor lock-in. Your secrets never leave infrastructure you control.
- **Free**: no per-seat pricing, no usage limits. Deploy it once, use it forever.
- **Open source**: MIT licensed. Read the code, audit it, extend it.

### Why teams need this

- **No more `.env` files**: secrets live in the cloud and are easy to share across machines. No more "can you send me the .env?" on Slack.
- **Single source of truth**: stop duplicating secrets across platforms. In CI, you only need the Sigillo token. Use built-in scripts to sync secrets to Cloudflare, Vercel, Docker, and more.
- **Collaborative secrets**: share secrets between team members through organizations with role-based access, instead of brittle `.env` files or pasting keys in DMs.
- **Multi-environment management**: manage dev, staging, and production secrets in one place. Switch between environments with `-c production`.

### Why agents need this

- **Don't let agents read your secrets**: agents should never see your raw secret values. Instead of giving agents access to `.env` files, use `sigillo run` to inject secrets into processes without exposing them.
- **Automatic output redaction**: `sigillo run` replaces secret values in stdout/stderr with `*`, so secrets never enter your chat context window. Even if an agent runs `printenv`, it won't see the real values in the output.

## Install skill for AI agents

```bash
npx -y skills add remorses/sigillo
```

This installs [skills](https://skills.sh) for AI coding agents like Claude Code, Cursor, Windsurf, and others.

## Install

**curl** (downloads the native binary to `~/.sigillo/bin`):

```bash
curl -fsSL https://sigillo.dev/install.sh | bash
```

**npm**:

```bash
npm i -g sigillo
```

**Run without installing** via npx or bunx:

```bash
npx sigillo run -- next dev
bunx sigillo run -- next dev
```

## Quick start

**1. Add your secrets** at [sigillo.dev](https://sigillo.dev) (or your self-hosted instance). Create a project, add environments, and paste in your secrets from the web UI.

**2. Login from the terminal** (opens a browser for device flow authentication):

```bash
sigillo login
```

**3. Link your project** (picks the default project and environment for this directory):

```bash
sigillo setup
```

This saves the project and environment for the current directory in `~/.sigillo/config.json` (not in the repo). Run it in the project root if you have a single project, or in each subfolder of a monorepo. Since the config is local to your machine, you need to run `sigillo setup` again after cloning the repo on a new machine. Alternatively, skip setup entirely and always pass `--project` and `--env` (or `-c`) flags.

**4. Run your app** with secrets injected as environment variables:

```bash
sigillo run -- next dev
```

That's it. No `.env` files, no copy-pasting keys. Go back to [sigillo.dev](https://sigillo.dev) any time to add, edit, or rotate secrets. The next `sigillo run` picks them up automatically.

Migrating from Doppler? See the [Doppler migration guide](docs/doppler-migration.md).

## Setting up a new project

The Quick Start above assumes you already have a project with secrets. This section walks through creating everything from scratch, either from the CLI or the [dashboard](https://sigillo.dev).

Sigillo organizes secrets into a simple hierarchy:

```diagram
Organization (my-company)
│
├── Project (api)
│   ├── dev
│   │   ├── DATABASE_URL = postgres://localhost/mydb
│   │   ├── API_KEY = sk-dev-xxx
│   │   └── AUTH_SECRET = random-dev-key
│   ├── preview
│   │   ├── DATABASE_URL = postgres://preview-host/mydb
│   │   └── API_KEY = sk-preview-xxx
│   └── prod
│       ├── DATABASE_URL = postgres://prod-host/mydb
│       └── API_KEY = sk-live-xxx
│
└── Project (web)
    ├── dev
    │   └── NEXT_PUBLIC_API_URL = http://localhost:3001
    └── prod
        └── NEXT_PUBLIC_API_URL = https://api.example.com
```

Each **organization** contains multiple **projects**. Each project has **environments** (dev, preview, prod by default). Secrets are scoped to a single environment.

### Create an organization

Organizations group projects and team members together. You need one before creating any project.

**CLI:**

```bash
sigillo orgs create --name my-company
```

**Dashboard:** Go to [sigillo.dev](https://sigillo.dev) and click "Create Organization" from the sidebar.

### Create a project

A project holds secrets for one app or service. Creating a project automatically gives you three environments: **dev**, **preview**, and **prod**.

```bash
sigillo orgs   # find your org ID
sigillo projects create --org <ORG_ID> --name my-app
```

**Dashboard:** Open your org, click "New Project", and give it a name. The three default environments are created for you.

### Link a directory

`sigillo setup` saves the **default project and environment** for the current directory. This is a local-only setting stored in `~/.sigillo/config.json`, not in the repository. After setup, every `sigillo run` in that directory (or any subdirectory) resolves the right secrets without extra flags.

Run it in the **project root** for single-project repos, or in **each subfolder** of a monorepo:

```bash
# single project
cd my-app
sigillo setup --project <PROJECT_ID> --env dev

# monorepo
cd monorepo/api     && sigillo setup --project api_xxx --env dev
cd monorepo/web     && sigillo setup --project web_xxx --env dev
```

Since the config lives on your machine (not in the repo), you need to re-run `sigillo setup` after cloning on a new machine. If you prefer not to run setup at all, you can always pass `--project` and `--env` explicitly:

```bash
sigillo run --project <PROJECT_ID> -c dev -- next dev
```

Without flags, `sigillo setup` shows an interactive picker. Use `--project` and `--env` for non-interactive/CI workflows.

### Add secrets

Add the secrets your app needs. You can set real values now, or leave them empty and fill them in later from the dashboard.

```bash
sigillo secrets set DATABASE_URL "postgres://localhost:5432/mydb" -c dev
sigillo secrets set API_KEY "" -c dev
sigillo secrets set AUTH_SECRET "" -c dev
```

Repeat for other environments:

```bash
sigillo secrets set DATABASE_URL "" -c preview
sigillo secrets set DATABASE_URL "" -c prod
```

For encryption keys or auth secrets, generate a real random value right away:

```bash
sigillo secrets set AUTH_SECRET "$(openssl rand -base64 32)" -c dev
sigillo secrets set AUTH_SECRET "$(openssl rand -base64 32)" -c preview
sigillo secrets set AUTH_SECRET "$(openssl rand -base64 32)" -c prod
```

**Dashboard:** Open your project at `sigillo.dev/orgs/<ORG_ID>/projects/<PROJECT_ID>/envs/dev` to add or edit secrets from the web UI. You can toggle between environments using the tabs.

### Verify and run

```bash
sigillo secrets -c dev   # list secret names (values hidden)
sigillo run -c dev -- pnpm dev
```

## Features

| Feature | Description |
|---|---|
| **Secret injection** | `sigillo run -- <cmd>` injects secrets as env vars, no files on disk |
| **Output redaction** | High-entropy values automatically replaced with `*` in stdout/stderr |
| **File mount** | `--mount .env` writes secrets to the given file path, deletes it after the process exits |
| **Organizations** | Multi-tenant orgs with admin/member roles and invite links |
| **Projects & environments** | Organize secrets into projects with dev/preview/production environments |
| **Audit log** | Append-only event log tracks every secret change with user attribution |
| **API tokens** | Scoped to project or single environment, SHA-256 hashed, shown once |
| **Device flow** | RFC 8628 login for CLI and agents, no copy-pasting tokens |
| **AES-256-GCM encryption** | Every secret encrypted at rest with a random 12-byte IV |
| **Download formats** | Export as `json`, `env`, `yaml`, `docker`, `dotnet-json`, `xargs` |
| **Web UI** | Full management dashboard with Doppler-style hidden values |
| **Self-hostable** | Runs on Cloudflare Workers + D1, deploy your own instance |
| **REST API** | OpenAPI-documented API for building custom integrations |

## CLI reference

### `sigillo login`

Authenticate via device flow or bearer token.

```bash
sigillo login                                              # interactive device flow
sigillo login --token sig_xxx                              # save existing API token
sigillo login --api-url https://my-instance.dev --scope .  # custom instance, scoped to current dir
```

### `sigillo setup`

Save the default project and environment for the current directory. This is stored locally in `~/.sigillo/config.json`, not in the repo, so it needs to be done on each machine after cloning. Run it in the project root, or in each subfolder of a monorepo. You can skip setup entirely by always passing `--project` and `--env` flags to other commands.

```bash
sigillo setup                                    # interactive project/env picker
sigillo setup --project proj_abc --env dev        # non-interactive
```

### `sigillo run`

Execute a command with secrets injected as environment variables.

```bash
sigillo run -- next dev                                          # inject secrets from the configured env
sigillo run -c dev -- next dev                                   # use the dev environment
sigillo run -c preview -- next dev                               # use the preview environment
sigillo run -c production -- next build                          # use the production environment
sigillo run -- printenv                                          # verify which vars are injected (values redacted)
sigillo run --command 'echo $MY_SECRET'                          # shell string mode
sigillo run --mount .env -- npm start                            # write to file, clean up after
sigillo run --mount config.json --mount-format json -- next dev  # mount as JSON
sigillo run --disable-redaction -- ./my-script.sh                # opt out of output redaction
```

Use **`--command`** when you need shell features like `&&`, pipes, redirects, or `$VARIABLE` expansion. Wrap the command in single quotes so your parent shell does not expand secret variables before Sigillo injects them.

```bash
# Wrong: your shell expands $DATABASE_URL before sigillo starts
sigillo run --command "psql $DATABASE_URL -c 'select 1'"

# Right: $DATABASE_URL expands inside sigillo's child shell
sigillo run --command 'psql $DATABASE_URL -c "select 1"'
```

Put **non-secret env vars before** `sigillo run`, especially in package scripts. This keeps regular build flags visible while secrets still come from Sigillo.

```json
{
  "scripts": {
    "deployment": "CLOUDFLARE_ENV=preview sigillo run -c preview --command 'vite build && wrangler deploy --env preview'"
  }
}
```

**Output redaction** is enabled by default. Secret values with high entropy (>=3.5 Shannon bits, >=16 chars) are replaced with `*` in stdout/stderr. This prevents secrets from leaking into agent context windows or CI logs.

### Local package binaries

When you run `sigillo run` through a package manager script (`pnpm run`, `bun run`, `npm run`), the package manager adds `node_modules/.bin` to `PATH` before Sigillo starts. Sigillo inherits that `PATH` and passes it to the child process, so local binaries like `vite`, `tsc`, `wrangler` are all available without prefixing with `pnpm exec` or `npx`.

```bash
# in package.json scripts, local bins just work:
sigillo run -- vite build          # vite found via node_modules/.bin
sigillo run -- wrangler deploy     # wrangler found via node_modules/.bin
sigillo run -- tsc --noEmit        # tsc found via node_modules/.bin

# same with --command:
sigillo run --command 'vite build && wrangler deploy'
```

This also works when running `sigillo run` directly with `pnpm exec` or `bunx`:

```bash
pnpm exec sigillo run -- vite dev
bunx sigillo run -- next build
```

If you installed Sigillo globally (via `curl` or `npm i -g`), running `sigillo run` outside a package manager script means `node_modules/.bin` is **not** in `PATH`. In that case, use the full path or prefix with `npx`/`pnpm exec` inside the child command, or run Sigillo from a package script instead.

### `sigillo secrets`

Manage individual secrets.

```bash
sigillo secrets                           # list secret names
sigillo secrets get DATABASE_URL          # get a single value
sigillo secrets get DATABASE_URL --force  # allow value output inside agent shells
sigillo secrets set API_KEY sk-live-xxx   # set a value
echo "multiline\nvalue" | sigillo secrets set CERT  # set from stdin
sigillo secrets delete OLD_KEY            # delete
sigillo secrets download                  # download all (YAML)
sigillo secrets download --format json    # download as JSON
sigillo secrets download --format env     # download as .env
```

Inside AI agent shells, `secrets get` and `secrets download` refuse to print raw values to a terminal unless you pass `--force`. Prefer `sigillo run` or a direct pipe so secret values go straight to the tool that needs them, not into the chat context.

```bash
sigillo run --command 'psql "$DATABASE_URL" -c "select 1"'
sigillo secrets download --format env | fly secrets import --app my-app
```

### `sigillo projects`

```bash
sigillo projects                                    # list all projects
sigillo projects create --org org_abc --name my-app # create project
sigillo projects get proj_abc                       # show project details
sigillo projects update proj_abc --name new-name    # rename
sigillo projects delete proj_abc                    # delete
```

### `sigillo environments`

```bash
sigillo environments                                                         # list environments
sigillo environments create --project proj_abc --name Staging --slug staging  # create
sigillo environments rename env_abc --name Production --slug prod             # rename
sigillo environments delete env_abc                                          # delete
```

### Global flags

Most commands that resolve auth, project, or environment from config accept these overrides:

| Flag | Env var | Description |
|---|---|---|
| `--token <sig_xxx>` | `SIGILLO_TOKEN` | Bearer token for auth |
| `--api-url <url>` | `SIGILLO_API_URL` | API endpoint (default: `https://sigillo.dev`) |
| `--env <slug>` / `--config <slug>` / `-c <slug>` | `SIGILLO_ENVIRONMENT` | Environment slug (e.g. `dev`, `prod`) |
| `--project <id>` / `-p <id>` | `SIGILLO_PROJECT` | Project ID override |

### Download formats

| Format | Flag | Use case |
|---|---|---|
| `json` | `--format json` | Application config files |
| `env` | `--format env` | Shell scripts with quotes |
| `env-no-quotes` | `--format env-no-quotes` | Shell scripts without quotes |
| `yaml` | `--format yaml` | Default CLI output |
| `docker` | `--format docker` | Docker `--env-file` |
| `dotnet-json` | `--format dotnet-json` | .NET `appsettings.json` (uses `__` for nested keys) |
| `xargs` | `--format xargs` | NUL-delimited pairs for shell pipelines |

## Integrations

### Cloudflare Workers

Upload secrets to a Cloudflare Worker using `wrangler secret bulk`:

```bash
sigillo run -c production --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod
```

Add these as `package.json` scripts so you can sync before each deploy:

```json
{
  "scripts": {
    "secrets:preview": "sigillo run -c preview --mount .env.preview --mount-format env -- wrangler secret bulk --env preview .env.preview",
    "secrets:production": "sigillo run -c production --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod"
  }
}
```

### Vercel

`vercel env add` only accepts one variable at a time. Use the `xargs` format to pipe them:

```bash
sigillo secrets download -c production --format xargs | \
  xargs -0 -n2 sh -c 'printf %s "$2" | vercel env add "$1" production --force' sh
```

Add `--sensitive` to mark values as sensitive in Vercel:

```bash
sigillo secrets download -c production --format xargs | \
  xargs -0 -n2 sh -c 'printf %s "$2" | vercel env add "$1" production --sensitive --force' sh
```

As a `package.json` script:

```json
{
  "scripts": {
    "secrets:vercel": "sigillo secrets download -c production --format xargs | xargs -0 -n2 sh -c 'printf %s \"$2\" | vercel env add \"$1\" production --sensitive --force' sh"
  }
}
```

### Fly.io

`fly secrets import` reads `NAME=VALUE` pairs from stdin. Pipe `sigillo secrets download` directly, no temp file needed:

```bash
sigillo secrets download -c production --format env | fly secrets import --app my-app
```

By default `fly secrets import` triggers a machine restart once secrets are staged. Use `--stage` to skip the restart and deploy separately:

```bash
# stage without restarting
sigillo secrets download -c production --format env | fly secrets import --app my-app --stage
# then deploy when ready
fly deploy --app my-app
```

Add as `package.json` scripts:

```json
{
  "scripts": {
    "secrets:fly:production": "sigillo secrets download -c production --format env | fly secrets import --app my-app",
    "secrets:fly:preview": "sigillo secrets download -c preview --format env | fly secrets import --app my-app-staging"
  }
}
```

### Docker

Mount secrets as a Docker env file:

```bash
sigillo secrets download --format docker > .env.docker
docker run --env-file .env.docker my-image
```

Or inject at build time:

```bash
sigillo run -- docker compose up
```

### CI / GitHub Actions

Use an API token for non-interactive environments:

```yaml
- name: Run with secrets
  env:
    SIGILLO_TOKEN: ${{ secrets.SIGILLO_TOKEN }}
    SIGILLO_PROJECT: ${{ vars.SIGILLO_PROJECT }}
    SIGILLO_ENVIRONMENT: ${{ vars.SIGILLO_ENVIRONMENT }}
  run: |
    npx sigillo run -- next build
```

### .NET

Download secrets as a hierarchical JSON file (keys with `__` become nested objects):

```bash
sigillo secrets download --format dotnet-json > appsettings.Secrets.json
```

`DB__HOST=localhost` becomes `{ "Db": { "Host": "localhost" } }`.

## Self-hosting

Sigillo runs on **Cloudflare Workers + D1**. You only need to deploy the **App Worker**. The Provider Worker (authentication) is optional because your self-hosted instance can use the hosted provider at `auth.sigillo.dev` by default.

```diagram
Your Cloudflare account              Sigillo Cloud
┌──────────────────────┐             ┌──────────────────────┐
│   App Worker         │   OAuth     │  Provider Worker     │
│   (your secrets)     │────────────▶│  (auth.sigillo.dev)  │
│                      │    PKCE     │                      │
│  You deploy this     │◀────────────│  Already running     │
└──────────────────────┘             └──────────────────────┘
```

This means you don't need Google OAuth credentials and the deployment is a single worker.

1. Clone the repo and install dependencies:

```bash
git clone https://github.com/remorses/sigillo.git
cd sigillo && pnpm install
```

2. Create `app/.dev.vars` with your secrets:

```
BETTER_AUTH_SECRET=<any random string>
ENCRYPTION_KEY=<output of: openssl rand -base64 32>
```

3. Run locally:

```bash
pnpm --dir app dev
```

4. Deploy:

```bash
pnpm --dir app deployment            # deploy preview worker
pnpm --dir app deployment:prod       # deploy production worker
```

The app auto-registers with `auth.sigillo.dev` on first request via [RFC 7591](https://tools.ietf.org/html/rfc7591) dynamic client registration. No Google OAuth credentials needed, no manual setup.

### Self-hosting the provider (optional)

By default, your self-hosted app uses `auth.sigillo.dev` for authentication. If you want a fully air-gapped setup with no dependency on Sigillo cloud, you can deploy the Provider Worker yourself.

1. Create `provider/.dev.vars` (requires Google OAuth credentials):

```
BETTER_AUTH_SECRET=<any random string>
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth client secret>
```

2. Deploy the provider:

```bash
pnpm --dir provider deployment       # deploy preview
pnpm --dir provider deployment:prod  # deploy production
```

3. Point the app at your self-hosted provider by changing `PROVIDER_URL` in `app/wrangler.jsonc`:

```jsonc
{
  "vars": {
    "PROVIDER_URL": "https://your-provider.your-domain.com"
  }
}
```

Then redeploy the app. It will auto-register with your provider on the next request.

## How it works

<details>
<summary><b>Architecture</b></summary>

Sigillo is two Cloudflare Workers in a monorepo, each backed by a D1 (SQLite) database:

```diagram
┌─────────────────────────────────────────────────────────────────┐
│                         Your Machine                            │
│                                                                 │
│  sigillo run -- next dev                                        │
│       │                                                         │
│       │  device flow login (RFC 8628)                           │
│       │  or bearer token                                        │
│       ▼                                                         │
│  ┌──────────┐                                                   │
│  │ Sigillo  │                                                   │
│  │   CLI    │                                                   │
│  └────┬─────┘                                                   │
│       │                                                         │
└───────┼─────────────────────────────────────────────────────────┘
        │ REST API
        ▼
┌──────────────────────┐         ┌──────────────────────┐
│   App Worker         │         │  Provider Worker     │
│   (self-hosted)      │────────▶│  (auth.sigillo.dev)  │
│                      │  OAuth  │                      │
│  • Secrets CRUD      │  PKCE   │  • Google login      │
│  • AES-256-GCM       │         │  • OAuth2 / OIDC     │
│  • Audit log         │◀────────│  • Dynamic client    │
│  • API tokens        │  token  │    registration      │
│  • Device flow       │         │                      │
│  ┌────────────┐      │         │  ┌────────────┐      │
│  │  D1 (app)  │      │         │  │ D1 (auth)  │      │
│  └────────────┘      │         │  └────────────┘      │
└──────────────────────┘         └──────────────────────┘
```

**App**: the secret manager you self-host. Handles secrets encryption, organizations, projects, environments, and the web UI.

**Provider**: centralized OAuth provider at `auth.sigillo.dev`. Self-hosted instances register automatically via [RFC 7591](https://tools.ietf.org/html/rfc7591) dynamic client registration as public PKCE clients (no client secret needed).

</details>

<details>
<summary><b>Auth flow</b></summary>

```diagram
CLI/Agent                    App (self-hosted)              Provider (auth.sigillo.dev)
   │                              │                                │
   │  POST /api/auth/device/code  │                                │
   │─────────────────────────────▶│                                │
   │  { user_code, device_code }  │                                │
   │◀─────────────────────────────│                                │
   │                              │                                │
   │  User opens /device          │                                │
   │  and enters user_code        │                                │
   │         ┌────────────────────┼────── redirect ───────────────▶│
   │         │                    │                                │
   │         │                    │              Google sign-in ──▶│ Google
   │         │                    │              ◀── callback ─────│
   │         │                    │                                │
   │         │                    │◀── auth code (PKCE) ───────────│
   │         └────────────────────┼────── approved ───────────────▶│
   │                              │                                │
   │  Poll /api/auth/device/token │                                │
   │─────────────────────────────▶│                                │
   │  { access_token }            │                                │
   │◀─────────────────────────────│                                │
```

</details>

<details>
<summary><b>Local dev vs CI authentication</b></summary>

Two auth paths depending on the environment:

```diagram
  Local development                     CI / GitHub Actions
  ─────────────────                     ───────────────────

  sigillo login                         SIGILLO_TOKEN=sig_xxx
       │                                     │
       ▼                                     │
  Browser opens /device                      │
       │                                     │
       ▼                                     │
  Enter user_code                            │
       │                                     │
       ▼                                     │
  Google sign-in                             │
       │                                     │
       ▼                                     ▼
  Session cookie saved               Bearer token from env
  in ~/.sigillo/config.json           var or GitHub secret
       │                                     │
       ▼                                     ▼
  sigillo run -- next dev             sigillo run -- next build
```

**Local**: interactive device flow (RFC 8628). Run `sigillo login` once, then the session is reused.

**CI**: set `SIGILLO_TOKEN` as a secret in your CI provider. No browser needed, no interactive prompts.

</details>

<details>
<summary><b>Secrets encryption</b></summary>

Every secret value is **AES-256-GCM** encrypted before storage. Each write generates a random 12-byte IV. The encryption key is either:

- `ENCRYPTION_KEY`: 32 random bytes, base64-encoded (`openssl rand -base64 32`)
- Derived from `BETTER_AUTH_SECRET` via SHA-256 (default if `ENCRYPTION_KEY` is not set)

```diagram
  plaintext value ("sk-live-xxx")
        │
        ▼
  ┌─────────────┐     ┌──────────────┐
  │ AES-256-GCM │◀────│  12-byte     │
  │   encrypt   │     │  random IV   │
  └──────┬──────┘     └──────────────┘
         │
         ▼
  ┌────────────────────────────────┐
  │ secretEvent (append-only row)  │
  │                                │
  │  action:    "set"              │
  │  name:      "API_KEY"          │
  │  value:     <iv>:<ciphertext>  │
  │  userId:    usr_abc            │
  │  createdAt: 1719000000         │
  └────────────────────────────────┘
```

Secrets are stored as an **append-only event log**. Current values are derived by replaying events. This gives you a full audit trail of every change with user/token attribution.

</details>

<details>
<summary><b>REST API</b></summary>

The app exposes a full REST API with OpenAPI documentation at `/api/openapi.json`.

```bash
# list secrets
curl -H "Authorization: Bearer sig_xxx" \
  https://sigillo.dev/api/environments/{envId}/secrets

# set a secret
curl -X POST -H "Authorization: Bearer sig_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "API_KEY", "value": "sk-live-xxx"}' \
  https://sigillo.dev/api/environments/{envId}/secrets

# bulk download as JSON
curl -H "Authorization: Bearer sig_xxx" \
  https://sigillo.dev/api/environments/{envId}/secrets/download?format=json

# bulk set
curl -X PUT -H "Authorization: Bearer sig_xxx" \
  -H "Content-Type: application/json" \
  -d '{"secrets": {"KEY1": "val1", "KEY2": "val2"}}' \
  https://sigillo.dev/api/environments/{envId}/secrets
```

</details>

## License

MIT
