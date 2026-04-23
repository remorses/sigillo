<div align='center'>
    <br/>
    <br/>
    <h3>sigillo</h3>
    <p>Self-hostable secrets manager for humans & agents</p>
    <br/>
    <br/>
</div>

Sigillo replaces `.env` files with a **cloud-based secrets manager** you can self-host. Instead of reading from local files, prefix your commands with `sigillo run` — secrets are injected as environment variables, never written to disk.

```bash
# instead of this
source .env && next dev

# do this
sigillo run -- next dev
```

Secrets are **automatically redacted** from process output so they never leak into agent context windows, CI logs, or terminal history.

**Open-source alternative** to [Doppler](https://doppler.com) and [Infisical](https://infisical.com).

## Why Sigillo?

### Why not Doppler or Infisical?

- **Self-hosted** — Runs on your own Cloudflare account. No centralized point of failure, no vendor lock-in. Your secrets never leave infrastructure you control.
- **Free** — No per-seat pricing, no usage limits. Deploy it once, use it forever.
- **Open source** — MIT licensed. Read the code, audit it, extend it.

### Why teams need this

- **No more `.env` files** — Secrets live in the cloud and are easy to share across machines. No more "can you send me the .env?" on Slack.
- **Single source of truth** — Stop duplicating secrets across platforms. In CI, you only need the Sigillo token. Use built-in scripts to sync secrets to Cloudflare, Vercel, Docker, and more.
- **Collaborative secrets** — Share secrets between team members through organizations with role-based access, instead of brittle `.env` files or pasting keys in DMs.
- **Multi-environment management** — Manage dev, staging, and production secrets in one place. Switch between environments with `-c production`.

### Why agents need this

- **Don't let agents read your secrets** — Agents should never see your raw secret values. Instead of giving agents access to `.env` files, use `sigillo run` to inject secrets into processes without exposing them.
- **Automatic output redaction** — `sigillo run` replaces secret values in stdout/stderr with `*`, so secrets never enter your chat context window. Even if an agent runs `printenv`, it won't see the real values in the output.

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

**2. Login from the terminal** — opens a browser for device flow authentication:

```bash
sigillo login
```

**3. Link your project** — picks up the project and environment you created:

```bash
sigillo setup
```

This saves the project and environment for the current directory in `~/.sigillo/config.json`. Any subdirectory automatically resolves the right secrets from that point on.

**4. Run your app** with secrets injected as environment variables:

```bash
sigillo run -- next dev
```

That's it. No `.env` files, no copy-pasting keys. Go back to [sigillo.dev](https://sigillo.dev) any time to add, edit, or rotate secrets — the next `sigillo run` picks them up automatically.

## Setting up a new project

The Quick Start above assumes you already have a project with secrets. This section walks through creating everything from scratch, either from the CLI or the [dashboard](https://sigillo.dev).

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

`sigillo setup` saves the project and environment for the current directory in `~/.sigillo/config.json`. After this, every `sigillo run` in that directory (or any subdirectory) automatically resolves the right secrets without extra flags.

```bash
cd my-app
sigillo setup --project <PROJECT_ID> --env dev
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
| **Device flow** | RFC 8628 login for CLI and agents — no copy-pasting tokens |
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

Link the current directory to a project and environment. Interactive prompts guide you through selection.

```bash
sigillo setup                                    # interactive project/env picker
sigillo setup --project proj_abc --env prod       # non-interactive (CI)
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

**Output redaction** is enabled by default — secret values with high entropy (≥3.5 Shannon bits, ≥16 chars) are replaced with `*` in stdout/stderr. This prevents secrets from leaking into agent context windows or CI logs.

### `sigillo secrets`

Manage individual secrets.

```bash
sigillo secrets                           # list secret names
sigillo secrets get DATABASE_URL          # get a single value
sigillo secrets set API_KEY sk-live-xxx   # set a value
echo "multiline\nvalue" | sigillo secrets set CERT  # set from stdin
sigillo secrets delete OLD_KEY            # delete
sigillo secrets download                  # download all (YAML)
sigillo secrets download --format json    # download as JSON
sigillo secrets download --format env     # download as .env
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
| `--project <id>` | `SIGILLO_PROJECT` | Project ID override |

### Download formats

| Format | Flag | Use case |
|---|---|---|
| `json` | `--format json` | Application config files |
| `env` | `--format env` | Shell scripts with quotes |
| `env-no-quotes` | `--format env-no-quotes` | Shell scripts without quotes |
| `yaml` | `--format yaml` | Default CLI output |
| `docker` | `--format docker` | Docker `--env-file` |
| `dotnet-json` | `--format dotnet-json` | .NET `appsettings.json` (uses `__` → nested keys) |
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

`fly secrets import` reads `NAME=VALUE` pairs from stdin — pipe `sigillo secrets download` directly, no temp file needed:

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

Sigillo runs on **Cloudflare Workers + D1**. To deploy your own instance:

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

3. Create `provider/.dev.vars`:

```
BETTER_AUTH_SECRET=<any random string>
GOOGLE_CLIENT_ID=<your Google OAuth client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth client secret>
```

4. Run locally:

```bash
pnpm --dir provider dev     # start provider (runs migrations automatically)
pnpm --dir app dev           # start app (runs migrations automatically)
```

5. Deploy to production:

```bash
pnpm --dir provider deployment    # deploy provider worker
pnpm --dir app deployment         # deploy app worker
```

The app auto-registers with the provider on first request via dynamic client registration. No manual OAuth setup needed.

## How it works

<details>
<summary><b>Architecture</b></summary>

Sigillo is two Cloudflare Workers in a monorepo, each backed by a D1 (SQLite) database:

```
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

**App** — The secret manager you self-host. Handles secrets encryption, organizations, projects, environments, and the web UI.

**Provider** — Centralized OAuth provider at `auth.sigillo.dev`. Self-hosted instances register automatically via [RFC 7591](https://tools.ietf.org/html/rfc7591) dynamic client registration as public PKCE clients (no client secret needed).

</details>

<details>
<summary><b>Auth flow</b></summary>

```
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
<summary><b>Secrets encryption</b></summary>

Every secret value is **AES-256-GCM** encrypted before storage. Each write generates a random 12-byte IV. The encryption key is either:

- `ENCRYPTION_KEY` — 32 random bytes, base64-encoded (`openssl rand -base64 32`)
- Derived from `BETTER_AUTH_SECRET` via SHA-256 (default if `ENCRYPTION_KEY` is not set)

Secrets are stored as an **append-only event log** — current values are derived by replaying events. This gives you a full audit trail of every change with user/token attribution.

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
