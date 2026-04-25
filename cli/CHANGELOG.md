# Changelog

## 0.7.0

1. **New `sigillo orgs` and `sigillo orgs create` commands** — manage organizations from the terminal:

   ```bash
   # list your organizations
   sigillo orgs

   # create a new organization
   sigillo orgs create --name "My Team"
   ```

   `orgs` prints a table of org IDs, names, and your role. `orgs create` creates a new org and shows its ID and name. Both work with `--token` and `--api-url` like every other command.

2. **`sigillo me` now shows current project/env setup** — when a project and/or environment is configured for the current directory (via `sigillo setup`), the me command prints a setup section showing the scoped directory, project ID, and env slug.

3. **Cleaner help with shared global options** — `--token` and `--api-url` now appear once in help output instead of repeating on every command. Project-, env-, and config-specific flags stay on the commands that use them. The zeke framework powers this under the hood.

4. **Empty string secrets are now allowed** — `sigillo secrets set KEY ""` no longer errors. Empty string values are valid secrets that get stored and decrypted correctly.

## 0.6.0

1. **Versioned `v0` API with project-scoped environment routes**. The CLI now talks to `/api/v0/...` and includes the project id on every environment-bound request. This makes env slug resolution consistent across `run`, `secrets`, and environment management commands on self-hosted installs:

   ```bash
   sigillo setup --project website --env dev
   sigillo run --env prod -- next start
   sigillo secrets download --format json
   ```

   Self-hosted app deployments now need to expose the new `v0` routes for the updated CLI.

2. **`environments get|rename|delete` now accept env slugs**. Slug support now covers the full environment command set instead of only setup and secrets flows:

   ```bash
   sigillo environments get production
   sigillo environments rename staging --slug preprod
   sigillo environments delete preview
   ```

3. **Local wrapper refresh is automatic after native builds**. Building the host target now refreshes the local `sigillo` wrapper in both `~/.local/bin` and pnpm's global bin directory, so the command in your shell keeps pointing at the current checkout without a separate install step.

## 0.5.0

1. **Environment slugs replace IDs in all CLI commands** — `--env` and `-c` now accept slugs like `dev`, `prod`, `staging` instead of raw ULIDs. `sigillo setup` stores the slug, interactive prompts show `Name (slug)`, and error hints list available slugs. The API accepts both IDs and slugs, so existing configs continue working without changes:

   ```bash
   sigillo setup --project website --env dev
   sigillo run --project website --env prod -- next start
   ```

2. **Pipe secret values via stdin** — `sigillo secrets set` now reads from stdin when the value argument is omitted. A single trailing newline from `echo` is stripped automatically:

   ```bash
   # pipe a value directly
   echo "my-api-key" | sigillo secrets set API_KEY

   # multiline values are preserved as-is
   cat private-key.pem | sigillo secrets set SSH_KEY
   ```

   If stdin is a TTY and no value is given, the CLI prints a usage hint instead of hanging.

## 0.4.0

1. **New file mount mode for `sigillo run`** — write secrets to a temporary file before launching your process, then clean it up automatically when the command exits:

   ```bash
   sigillo run --mount .env -- npm start
   sigillo run --mount config.json --mount-format json -- next dev
   sigillo run --mount secrets.yaml --mount-format yaml -- ./deploy.sh
   ```

   This is useful for tools that expect config files instead of plain environment variables.

2. **More download and mount formats, including Vercel sync support** — `sigillo secrets download` and `sigillo run --mount-format` now support Doppler-style formats like `env-no-quotes`, `docker`, `dotnet-json`, and `xargs`:

   ```bash
   sigillo secrets download --format json
   sigillo secrets download --format xargs | xargs -0 -n2 sh -c 'printf %s "$2" | vercel env add "$1" production --force' sh
   ```

   The new `xargs` mode emits NUL-delimited `KEY VALUE` pairs so spaces, quotes, and multiline secrets survive shell pipelines safely.

3. **`sigillo run` no longer falls over on huge child output** — redaction now streams stdout and stderr incrementally instead of buffering the whole process first, so long-running commands and very large logs keep working while still hiding secrets.

4. **New env aliases for scoped commands** — env-scoped commands now use `--env` as the main flag, with `--config` and `-c` available as aliases:

   ```bash
   sigillo setup --project website --env dev
   sigillo run --project website --env dev -- next dev
   sigillo run --project website -c production -- next dev
   ```

5. **Clearer project and env lookup errors** — when you pass a missing project or env, the CLI now shows the matching list of available projects or envs instead of leaving you with a generic fetch error.

## 0.3.0

1. **New CRUD commands for projects, environments, and secrets** — manage Sigillo resources from the terminal instead of jumping back to the web UI:

   ```bash
   sigillo projects
   sigillo projects create --org org_123 --name backend
   sigillo environments create --project proj_123 --name Production --slug production
   sigillo secrets set DATABASE_URL postgres://localhost:5432/app
   sigillo secrets download > secrets.yaml
   ```

   Adds `projects get|create|update|delete`, `environments get|create|rename|delete`, and `secrets get|set|delete|download`, with script-friendly plain-text output.

2. **Token-based login for CI and agent sessions** — save an existing bearer token without starting the device flow:

   ```bash
   SIGILLO_TOKEN=sig_xxx sigillo login --scope /
   sigillo login --token sig_xxx --scope /Users/me/project
   ```

   This makes it easier to reuse API tokens in automation while still letting `sigillo` resolve them through the normal scoped config.

3. **Interactive scope and setup prompts** — `sigillo login` can now ask whether auth should be saved globally or for the current directory, and `sigillo setup` can guide project/environment selection when you do not want to paste raw IDs.

4. **Safer `sigillo run` logs by default** — likely secret values are redacted from child stdout/stderr unless you explicitly opt out:

   ```bash
   sigillo run -- next dev
   sigillo run --disable-redaction -- next dev
   ```

5. **More reliable Windows behavior** — config now lives under `%APPDATA%\sigillo\config.json`, shell commands use the Windows command shell correctly, and browser launch/process execution are more reliable on Windows.

## 0.2.0

1. **`--api-url` now defaults to `https://sigillo.dev`** — no need to pass it when using the hosted version:

   ```bash
   # Before
   sigillo login --api-url https://sigillo.dev

   # Now
   sigillo login
   ```

   All commands (`login`, `me`, `setup`, `run`) default to `https://sigillo.dev`. Pass `--api-url` only when self-hosting.

2. **Colored terminal output** — error messages, labels, URLs, and success indicators are color-coded when connected to a TTY. Piped/redirected output stays plain text.

3. **`sigillo logout` no longer requires `--yes`** — just run `sigillo logout` directly.

4. **Interactive select picker (foundation)** — arrow-key selection prompt built into the CLI for upcoming interactive `setup` flow. Uses POSIX termios raw mode with no external dependencies; falls back to numbered list on Windows or non-TTY.

## 0.1.0

First real CLI release. Install via npm:

```bash
npm install -g sigillo
```

1. **`sigillo login`** — authenticate with device flow (RFC 8628). Opens a browser automatically and polls until approved:

   ```bash
   sigillo login --api-url https://secrets.example.com
   ```

   Saves credentials scoped to the current directory (or `--scope /path`).

2. **`sigillo run`** — inject secrets as environment variables into any command:

   ```bash
   # Pass command after --
   sigillo run -- node server.js

   # Or as a shell string
   sigillo run --command 'echo $DATABASE_URL'
   ```

   Fetches secrets from the configured project/environment and merges them into the child process environment. The child's exit code is forwarded.

3. **`sigillo setup`** — link the current directory to a project and environment:

   ```bash
   sigillo setup --project proj_123 --environment env_abc
   ```

   Saved in `~/.sigillo/config.json`, scoped by directory. `sigillo run` picks this up automatically.

4. **`sigillo me`** — show the currently logged-in user and their organizations:

   ```bash
   sigillo me
   sigillo me --json   # raw JSON
   ```

5. **`sigillo logout`** — remove saved auth for a scope:

   ```bash
   sigillo logout --yes
   sigillo logout --scope /Users/me/project --yes
   ```

**Platforms:** macOS arm64/x64, Linux arm64/x64 (musl — works on glibc and Alpine), Windows arm64/x64.
