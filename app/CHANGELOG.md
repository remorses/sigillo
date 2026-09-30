# Changelog

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
