# Changelog

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
