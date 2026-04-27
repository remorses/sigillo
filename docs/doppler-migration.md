# Doppler migration

Move one Doppler project into Sigillo without printing secret values in the terminal.

This guide assumes a human or agent is running commands step by step. It intentionally uses
placeholders instead of shell variables, loops, or scripts so secret values are never stored in
the process environment.

## 1. Log in to both CLIs

```bash
doppler login
sigillo login
```

If you are migrating into a self-hosted Sigillo instance, pass your API URL to Sigillo commands:

```bash
sigillo login --api-url <sigillo-api-url>
```

## 2. Create a Sigillo organization

Create the organization that will own the migrated projects:

```bash
sigillo orgs create --name <org-name>
```

List organizations and copy the new Sigillo organization ID:

```bash
sigillo orgs
```

You will use that value as `<sigillo-org-id>` in the next steps.

## 3. List Doppler projects

List the projects in the current Doppler workplace:

```bash
doppler projects
```

Pick the Doppler project to migrate. This guide refers to it as `<doppler-project>`.

## 4. Create the matching Sigillo project

Create a Sigillo project with the same name as the Doppler project:

```bash
sigillo projects create --org <sigillo-org-id> --name <doppler-project>
```

List Sigillo projects and copy the new project ID:

```bash
sigillo projects
```

You will use that value as `<sigillo-project-id>` when creating environments and secrets.

## 5. List Doppler environments and configs

Doppler stores root environment secret sets in **configs** like `dev`, `stg`, and `prd`.
List both environments and configs before creating anything in Sigillo:

```bash
doppler environments -p <doppler-project>
doppler configs -p <doppler-project>
```

Use this mapping when deciding what to create in Sigillo:

| Doppler | Sigillo |
|---|---|
| Project | Project |
| Root config, such as `dev`, `stg`, `prd` | Environment, such as `dev`, `preview`, `prod` |
| Branch or personal config | Separate Sigillo environment, if you need to keep it |

## 6. Create matching Sigillo environments

List the environments that already exist in the Sigillo project:

```bash
sigillo environments --project <sigillo-project-id>
```

Create any missing environments:

```bash
sigillo environments create --project <sigillo-project-id> --name <environment-name> --slug <environment-slug>
```

Examples:

```bash
sigillo environments create --project <sigillo-project-id> --name Staging --slug stg
sigillo environments create --project <sigillo-project-id> --name Production --slug prd
```

## 7. List Doppler secret names safely

List secret names for one Doppler config. This prints names only, not values:

```bash
doppler secrets --only-names -p <doppler-project> -c <doppler-config>
```

Example:

```bash
doppler secrets --only-names -p <doppler-project> -c dev
```

Keep this list open and copy each secret name into the command in the next step.

## 8. Copy each secret without printing it

Pipe each Doppler secret value directly into Sigillo. The value is not printed to the terminal:

```bash
doppler secrets get <secret-name> --plain -p <doppler-project> -c <doppler-config> |
  sigillo secrets set <secret-name> -p <sigillo-project-id> -c <sigillo-env>
```

Example:

```bash
doppler secrets get DATABASE_URL --plain -p <doppler-project> -c dev |
  sigillo secrets set DATABASE_URL -p <sigillo-project-id> -c dev
```

Repeat this command for every secret name from the previous step.

## 9. Repeat for every environment

Repeat the name listing and value piping steps for each Doppler config you want to migrate.

Common mapping:

| Doppler config | Sigillo environment |
|---|---|
| `dev` | `dev` |
| `stg` | `preview` or `stg` |
| `prd` | `prod` |

Example for staging:

```bash
doppler secrets --only-names -p <doppler-project> -c stg

doppler secrets get <secret-name> --plain -p <doppler-project> -c stg |
  sigillo secrets set <secret-name> -p <sigillo-project-id> -c preview
```

Example for production:

```bash
doppler secrets --only-names -p <doppler-project> -c prd

doppler secrets get <secret-name> --plain -p <doppler-project> -c prd |
  sigillo secrets set <secret-name> -p <sigillo-project-id> -c prod
```

## 10. Verify without revealing values

List migrated Sigillo secret names for each environment:

```bash
sigillo secrets --project <sigillo-project-id> -c <sigillo-env>
```

Avoid `sigillo secrets get` during verification unless you intentionally want to inspect a value.

## 11. Cut over your commands

Replace Doppler runtime injection:

```bash
doppler run -p <doppler-project> -c <doppler-config> -- pnpm dev
```

With Sigillo runtime injection:

```bash
sigillo run --project <sigillo-project-id> -c <sigillo-env> -- pnpm dev
```

Optionally save the Sigillo project and environment for the current directory:

```bash
sigillo setup --project <sigillo-project-id> --env <sigillo-env>
sigillo run -- pnpm dev
```

`sigillo setup` stores local CLI config in `~/.sigillo/config.json`. It does not write secrets to the
repository.
