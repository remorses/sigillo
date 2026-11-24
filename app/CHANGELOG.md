# Changelog

## 0.3.0

1. **Passkey approvals for secret reads.** A CLI, agent or API token can be required to get a human approval, confirmed with a passkey, before it reads protected secrets.

   - **Settings** has an **Approvals** card to choose per environment between **Off**, **Selected secrets** and **All secrets**, and a **Passkeys** card to manage your passkeys. Nothing is protected until an admin turns it on.
   - A blocked read returns `403` with an approval URL. Each session or token keeps adding to one pending request, so one passkey prompt approves everything.
   - The **Approvals** tab lists pending requests and active approvals. **Approve** grants in place, **Review details** opens the full page, **Revoke** ends an approval.
   - An approval belongs to the session or token that asked and ends 1 hour after its last use. API tokens can be approved until revoked.
   - The dashboard asks too: protected values show a lock, and revealing, copying or downloading them asks for your passkey and unlocks that environment for 1 minute.
   - Organizations trust exact passkeys. Set up trusted keys explicitly before enabling protection; later keys need approval from an already-trusted admin key. Protected organizations need a trusted admin confirmation for invitations, promotions, project access, environment roles and domain auto-join.
   - Renaming or deleting a protected environment, and renaming its project, asks for your passkey and only works in the dashboard.
   - One login can no longer read the session tokens of your other logins (`/api/auth/list-sessions` is off).
   - New REST routes `POST /api/v0/approvals` and `GET /api/v0/approvals/:id`.
   - After the upgrade, sign out and sign in again before you add a passkey or set up trust. The CLI keeps working without a new login.

2. **Rename and delete projects from project Settings.** A **Project name** card renames it. **Danger Zone** has a **Delete project** row whose confirm dialog lists the environments that will be deleted with their secrets, history and API tokens.

3. **Environment descriptions.** Click the **Description** cell on the project Environments page to view and edit it. The REST API accepts an optional `description` on `POST` and `PATCH /api/v0/projects/:projectId/environments`; send `""` to clear it.

4. **Better Auth 1.7.28.** The session cookie cache works again, so fewer requests hit the database. No app database migration is needed.

5. **Security fixes.** The auth provider no longer auto-accepts consent for custom-scheme redirect URIs such as `myapp://sigillo.dev/cb`. The installer extracts into a private temp directory.

6. **UI fixes.** Tables use one plain border. On mobile, pages no longer scroll sideways, the Secrets table keeps its key column readable, the active project tab scrolls into view, and Settings rows stack.

## 0.2.0

1. **Rename projects from the dashboard.** Click the project name at the top of any project tab, type the new name, then press Enter. Escape cancels.

2. **Secrets page marks only real changes.** An input gets the amber ring only when its value differs from the saved value. Typing and then restoring the original value clears the ring and removes the row from the save count. Key and value inputs ring independently.

## 0.1.1

1. **Manage access dialog keeps restrictions.** It could open with **Full access** checked for a restricted member, so saving without changes removed the restriction.

2. **Device login page recovers from errors.** It returns to code entry when Approve or Deny fails, so you can enter the new code.

3. **Homepage hero background is easier to see.** The ASCII shader no longer gets an extra opacity fade, each theme uses its own green, and a soft scrim keeps the title and buttons readable.

## 0.1.0

1. **API tokens can cover more than one environment.** Create a token for **dev** and **preview** without also granting **prod**. Project-wide tokens still mean every environment. The CLI setup picker lists only the environments the token can use.

2. **Project access and admin-only environments are enforced everywhere, and take effect immediately.** Before, only the REST secrets routes checked them. Now these check them too:

   - the secrets page and the event log (a member sees a locked page for an admin-only environment, no values)
   - saving to several environments, deleting secrets, and syncing missing secrets
   - creating, renaming and deleting environments, and deleting a project that holds an admin-only environment
   - creating and revoking API tokens (you need access to every environment the token covers)
   - using an API token on an admin-only environment (its creator must still be an org admin)

   Membership and environment lookups are no longer cached, so removing a member or making an environment admin-only applies on the next request, not up to 15 minutes later.

3. **Project restrictions survive project deletion, and secret names no longer leak.**

   - A member limited to some projects used to get access to **every** project when their last allowed project was deleted. The restriction is now stored on the membership, so they keep access to no projects.
   - Accepting a project-scoped invitation whose projects were deleted is refused, and a failed project-access update keeps the old rules.
   - The secrets list returned `allNames` from every environment in the project. It now returns only names from environments the member or token can read.

4. **Device login needs an explicit Approve.** `/device?user_code=…` used to approve the code in one click, so a link sent by someone else could sign them in as you. The page now shows a warning with **Approve** and **Deny** buttons.

5. **`.env` downloads can no longer run shell commands.** Values are single-quoted, so `source .env` does not expand `$(…)`, backticks or `$VAR`:

   ```sh
   SUBSHELL='$(touch /tmp/pwned)'
   QUOTE="it's"
   ```

   New and renamed secret names must match `^[A-Za-z_][A-Za-z0-9_]*$`. Unsafe names are dropped from env, docker and yaml downloads. The web **Download .env** button uses the same format.

6. **Deleting an API token or a user no longer deletes the secrets they wrote.** Secret history now sets the author to null, and the event log shows `—`.

7. **CLI docs cover git worktrees** and the new `sigillo setup --scope` flag from `sigillo` 0.14.0.

8. **Fixed changing a member role in the access table.** Selecting Admin or Member now saves, and removing a member from the table works again.

9. **Refreshed website homepage.** The hero reads **Secrets manager, open source Doppler alternative**, with an ASCII video background and **Login with Google** / **GitHub Repo** buttons. Docs use a compact layout; GitHub and Changelog links moved to the sidebar.

Fixes https://github.com/remorses/sigillo/issues/5
Fixes https://github.com/remorses/sigillo/issues/7
Fixes https://github.com/remorses/sigillo/issues/10
Fixes https://github.com/remorses/sigillo/issues/12
Fixes https://github.com/remorses/sigillo/issues/14

## 0.0.2

1. **Let `sig_` API tokens read their own project metadata** so CLI token login can run `setup`.

   Before this, a token worked on secrets routes but `sigillo setup --project X --env dev` called `GET /api/v0/projects/X` and got **401**. User (device-flow) login was fine. Token login was not.

   A project-scoped token can now call the read routes the CLI uses after `sigillo login --token`:

   ```bash
   sigillo login --api-url https://secrets.example.com --token sig_xxxxx
   sigillo setup --project <project-id> --env dev
   sigillo me
   sigillo orgs
   sigillo environments get dev
   ```

   | Route | Token can |
   |---|---|
   | `GET /api/v0/me` | yes. returns the token creator and that one org |
   | `GET /api/v0/orgs` | yes. that one org, role `member` |
   | `GET /api/v0/projects` | yes. only the token project |
   | `GET /api/v0/projects/:id` | yes. **403** if a different project |
   | `GET /api/v0/projects/:id/environments` | yes |
   | `GET /api/v0/projects/:id/environments/:id` | yes. **403** if env-scoped to a different env |
   | secrets routes | already worked |
   | create / rename / delete orgs, projects, envs | still **401** |

   Env-scoped tokens only see that environment in project payloads, so `setup --env prod` with a `dev` token fails early.

   Deleting a scoped environment now **revokes** the token (`ON DELETE CASCADE`). It used to `SET NULL`, which widened the token to every environment in the project. Self-hosted instances need migration `0006`.

   README curl examples now use `/api/v0/projects/{projectId}/environments/{environmentId}/secrets`. The old `/api/environments/{envId}/secrets` path does not exist.

   Fixes #4
