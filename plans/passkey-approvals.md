# Passkey approvals for secret reads plan

Agents and CLIs must get a human approval before they read protected secrets. The agent shows
one URL, the user approves every requested secret with one passkey prompt. Protection is opt-in
per environment or per secret. Model: npm staged publishing.

Check a box only when its evidence exists (command output, screenshot, log line, commit SHA).
Write the evidence next to the box. Verify on the real artifact, not tests alone.

## Reference: npm staged publishing

Sources: [staged publishing](https://docs.npmjs.com/staged-publishing/),
[stage-only tokens](https://github.blog/changelog/2026-09-18-stage-only-npm-tokens-for-safer-automation/).

| npm | Sigillo |
| --- | --- |
| `npm stage publish` needs no 2FA, the version waits in a staging area | a blocked read creates a pending **approval request** |
| agent gives the user `npmjs.com/settings/<user>/staged-packages` | agent gives the user `https://<host>/approve/<id>` |
| **Add to batch**, **Approve (N)**, one 2FA for all | all items of the request are pre-checked, one passkey prompt for all |
| 2FA (security key, passkey) proves a human approved | WebAuthn passkey stored in Sigillo, user verification required |
| stage-only token cannot publish directly | a session or token cannot read protected secrets without a grant |
| batch items are independent | the user can uncheck items before approving |

One difference: npm approves one publish. A secret is read many times (`sigillo run`), so an
approval creates a **grant** that lasts for a chosen time.

## Design

### Flow

```
 agent shell                      sigillo app (worker + D1)              user browser
 ───────────                      ─────────────────────────              ────────────
 sigillo run -c prod -- deploy
      │  GET .../secrets/download ──────▶ prod needs approval, no grant
      │                                   find or create the pending request
      │                                   of this credential, add the item
      │ ◀──── 403 approval_required ───── { error, code, approvalId, approvalUrl }
 prints the URL, exits 1
 agent shows the URL to the user ───────────────────────────────────▶ opens /approve/<id>
                                                                      reviews items
                                  ◀──── WebAuthn assertion ────────── Approve with passkey
                                  verify, status = approved,
                                  grant lives 1h after last use
 sigillo run -c prod -- deploy
      │  GET .../secrets/download ──────▶ grant covers prod for this credential
      │ ◀──── 200 secrets ───────────────
```

**Batching by editing.** A credential has at most one pending request, and agents edit it
instead of creating new ones. Each blocked read appends its item, so three blocked commands
return the same URL. `sigillo access request` adds items and sets the label on the same
request. See `plans/decisions/approval-request-editing.md`.

**Label.** The agent can describe why it asks (`--label 'Deploy website to prod'`, max 200
chars). The approve page shows it as a quoted note from the requester, never as the title: the
item list is the truth, the label is text written by an agent.

**Edits while the page is open.** The assertion is bound to the exact items shown. If the
request changed since the page loaded, approval fails and the page reloads with the new items.

### Rules

- **What is protected.** Decided per environment: `readApproval` is `off`, `selected` (only the
  names in `secret_approval` rows) or `all` (every secret, also ones added later). No
  project-wide switch: a project is its environments.
- **What needs a grant.** Every path that returns a decrypted value or copies ciphertext: REST
  `GET secrets/:name`, `GET secrets/download`, the dashboard secrets loader, the event log
  loader, and `syncMissingSecretsAction` (source env). Names, `isEmpty` and writes stay open.
- **A read returns all or fails.** `download` and `run` fail with 403 while any protected secret
  of the env has no grant. No partial downloads: an old CLI would start the app with missing
  variables and no message.
- **Grant.** Bound to one credential: a session id or an API token id. A grant for the CLI
  session does not unlock the browser, another session, or a token.
- **Expiry.** A grant expires **1 hour after its last use**. Every protected read with the
  grant counts as a use (`lastUsedAt`, written at most once a minute). No duration select.
  An agent that keeps working keeps its grant; an idle one loses it. API tokens can be
  approved **until revoked**, because CI may run less than once an hour. See
  `plans/decisions/approval-expiry.md`.
- **The website asks too.** Two reasons. The CLI login token is the same kind of session as the
  browser cookie, so it can load dashboard pages. Agents can also drive the user's logged-in
  browser. Without this, protection is bypassed in one request. Revealing a protected value
  asks for the passkey and unlocks that environment for the browser session for **1 minute**
  (fixed, no select). See `plans/decisions/dashboard-unlock.md`.
- **Who approves.** Session request: only the user of that session. Token request: a member who
  can create that token (same rule as `requireTokenScopeAccess`). The approver must pass the
  normal environment access check for every approved item.
- **Passkey needed for** (one server helper, assertion bound to the exact action and payload,
  single use, 5 minute challenge): approve a request, unlock in the browser, turn protection off
  for an env or secret, add a second passkey, delete a passkey.
- **First passkey.** Trust on first use, but never from a CLI session: device-flow sessions get
  `session.kind = 'cli'` and cannot enroll.

### Data model (Prisma syntax)

New tables `passkey`, `secret_approval`, `approval_request`, `approval_item`. New columns
`session.kind` and `environment.read_approval`. One migration: `db/drizzle-app/0011_passkey-approvals.sql`.

```prisma
model Session {
  // ...existing
  kind String @default("browser") // "browser" | "cli" (created by the device flow)
}

model Environment {
  // ...existing
  readApproval String @default("off") // "off" | "selected" (SecretApproval rows) | "all"
}

model Passkey {
  id           String @id // ulid
  userId       String // -> User, cascade
  name         String // "MacBook Touch ID"
  credentialId String @unique // base64url
  publicKey    String // base64url COSE key
  counter      Int    @default(0)
  transports   Json? // string[]
  rpId         String // host the passkey was created on
  createdAt    Int
  lastUsedAt   Int?

  @@index([userId])
}

// One protected secret name in one environment.
model SecretApproval {
  id            String  @id
  environmentId String // -> Environment, cascade
  name          String
  createdBy     String? // -> User, set null
  createdAt     Int

  @@unique([environmentId, name])
}

// Pending: the request. Approved: the grant. Kept after expiry as the audit trail.
model ApprovalRequest {
  id             String  @id // ulid, used in /approve/<id>
  userId         String? // requester (session user or token creator), set null
  sessionId      String? // -> Session, set null. Exactly one of sessionId / apiTokenId
  apiTokenId     String? // -> ApiToken, set null. Both null = credential deleted, grant dead
  label          String  @default("") // why, written by the requester. Max 200 chars
  status         String  @default("pending") // "pending" | "approved" | "denied" | "revoked"
  expiresAt      Int // pending request expiry (1h after the last added item)
  approvedBy     String? // -> User, set null
  approvedAt     Int?
  lastUsedAt     Int? // set at approval and on protected reads. Idle expiry counts from here
  expiry         String  @default("idle") // "idle": 1h after last use | "never": until revoked (API tokens)
  grantExpiresAt Int? // hard stop. Website unlock: approvedAt + 1 minute. null = none
  createdAt      Int

  @@index([sessionId, status])
  @@index([apiTokenId, status])
}

model ApprovalItem {
  id            String @id
  requestId     String // -> ApprovalRequest, cascade
  environmentId String // -> Environment, cascade
  secretName    String @default("") // "" = all secrets in the environment

  @@unique([requestId, environmentId, secretName])
  @@index([environmentId])
}
```

WebAuthn challenges reuse the existing BetterAuth `verification` table. No new table.

### API

| Route | Change |
| --- | --- |
| `GET .../secrets/:name`, `GET .../secrets/download` | 403 when a grant is missing (shape below) |
| `POST /api/v0/approvals` | new. `{ label?, items: [{ projectId, environment, secrets? }] }` edits the pending request of this credential (creates it if none): adds items, replaces the label when given. Returns `{ id, url, status, expiresAt }` |
| `GET /api/v0/approvals/:id` | new. Status for the credential that created it: `pending`, `approved`, `denied`, `expired` |

```json
{
  "error": "approval required. Open https://sigillo.dev/approve/01KX... and approve with your passkey, then run the command again",
  "code": "approval_required",
  "approvalId": "01KX...",
  "approvalUrl": "https://sigillo.dev/approve/01KX..."
}
```

The fields are flat so the CLI reads them with the existing `client.jsonString`.

### CLI

- `run`, `secrets get`, `secrets download` handle `code = approval_required` in one shared
  function.
- **Agent shell or no TTY** (`detectAgentNameFromEnvMap`, same check as the `--force` guard):
  print the URL and "ask the user to approve, then run again", exit 1. Agent shell tools show
  output only when the command ends, so the CLI must not wait.
- **Human TTY:** print the URL, open the browser, poll `GET /approvals/:id`, then retry the read.
  Same loop shape as `login`.
- New command, one URL for everything the agent will need. Running it again edits the same
  pending request and prints the same URL:

```bash
sigillo access request -c dev -c prod --label 'Deploy website'  # all secrets of two envs
sigillo access request -c dev --secret STRIPE_KEY               # adds one secret, same URL
```

`label` is sent only when `--label` is passed, so the request body stays valid for any server.

### Dashboard UX

Configuration lives in **Settings**. The **Approvals** tab only lists requests. See
`plans/decisions/approvals-ui-placement.md`.

**1. Settings page** (existing). Two new cards in the same style as "Project name", placed
after it:

- **Approvals.** One row per environment with one select (admins only): **Off**,
  **Selected secrets**, **All secrets**. "Selected secrets" shows chips of secret names and
  **+ Add secret** (picker of existing names) on a second line. Raising protection needs a
  passkey on the account; if none, the enroll dialog opens first. Lowering it (All to Selected
  or Off, or removing a chip) asks for the passkey.
- **Passkeys.** The user's passkeys: name, added, last used, **Remove**, **Add passkey**.

**2. Approvals tab** (new, `/dash/projects/:projectId/approvals`, after Access). Requests only:

- Header: project title, and one link **Configure in Settings** on the right.
- One list: pending requests with **Review** (opens the approve page), then active grants with
  who, what, "last used 12 min ago" and **Revoke**.
- **Empty state** (uses `EmptyState` directly on the page, no frame or border around it, like
  the Tokens page): shield icon, "No approval requests", one line that says
  requests from a CLI or agent show up here, and a button to Settings. The button reads
  **Choose protected secrets** when every env is Off, **Settings** otherwise.

**Borders.** One style everywhere: a normal 1px border with rounded corners, like the Settings
cards. The `Frame` look (muted padded wrapper around a shadowed panel) goes away on the whole
site: Secrets, Environments, Tokens, Access and Event Log tables, and the CLI banner. The
styles are coupled in `ui/frame.tsx` and the `in-data-[slot=frame]` variants of `ui/table.tsx`.

**Mobile.** Every new screen must work at 390px: request rows stack (title and badge, items,
meta, full-width **Review**), Settings rows keep name and select on one line with chips
wrapping below, full-width **Add passkey**. Also fix what the pass finds on touched pages:
the Danger Zone rows in Settings do not stack, and the tab bar now has 7 tabs, so the active
tab must scroll into view.

**3. Approve page** (new, standalone like `/device`, `/approve/:id`). Logged out users go
through `/login?redirect=`.

- Header: "**Tommy's CLI session** asks to read secrets" plus session age and user agent, or
  "API token **ci-deploy**". Under it the label as a quoted note, when set.
- Items grouped by project and env: "prod: all secrets" or the secret names. All checked;
  uncheck to exclude.
- No duration select. One line says "Access ends 1 hour after the last use". Token requests
  also get one checkbox: **Keep until revoked**.
- **Deny** and **Approve with passkey**. No passkey yet: the button is **Add a passkey**, then it
  becomes Approve.
- Warning line like the device page: approve only if you or your agent started this.
- Done state: "Approved. Run the command again."

**4. Secrets and Event Log pages.** No banner. Values are already masked by default, so the
passkey prompt sits on the existing reveal actions:

- The server never sends a protected value without a grant. The row shows the usual dots and a
  small lock on the eye icon.
- Clicking the eye, **Show all secrets**, **Copy as .env** or the copy-missing-secrets sync on a
  protected value asks for the passkey once, then the page reloads with the values of that
  environment.
- The unlock lasts 1 minute for this browser session. Values already on screen stay until the
  page loads data again (navigation or a save), then they are masked again.
- Editing needs no unlock: typing a new value overwrites the secret.
- The Approvals tab lists only CLI and token requests, not these 1 minute unlocks.

### Compatibility

| CLI | Server | Result |
| --- | --- | --- |
| old | new | 403 prints the `error` string, which holds the URL. User approves, reruns. No CLI update needed. |
| new | old | No protection exists, reads work as today. `access request` gets 404 and prints "this server is too old, redeploy it". |
| new | new | Full flow. |

No new response fields on existing 200 responses, so nothing goes in `ADDED_FIELD_DEFAULTS`.
The two new response types get Zig defaults for every field except `id` and `status`.

### Alternatives

| Question | Options | Pick |
| --- | --- | --- |
| WebAuthn code | **A.** `@simplewebauthn/server` + `/browser` with our own `passkey` table. **B.** `@better-auth/passkey` plugin | **A.** The plugin has no assertion bound to a custom payload, lets any session add a passkey (an agent could enroll its own), and adds passkey sign-in that skips the provider. |
| Grant lifetime | **A.** grant that expires 1h after its last use. **B.** fixed duration picked at approval. **C.** one approval per read, like npm | **A.** (user). `sigillo run` reads on every start, and an idle agent loses access with no setting to pick. |
| Request creation | **A.** implicit on a blocked read, plus an explicit batch command. **B.** explicit only | **A.** Old CLIs keep working and batching needs no agent knowledge. |
| Per-secret protection on `download` | **A.** fail closed. **B.** return the open secrets, skip the protected ones | **A.** B breaks apps silently on old CLIs. |
| API tokens | **A.** tokens need a grant, with "until revoked". **B.** tokens are exempt | **A.** B lets a session create a token and read everything. |
| Session kind | **A.** mark device-flow sessions in a `session.create` hook. **B.** tell by cookie vs bearer | **A.** The bearer plugin returns the signed cookie value in `set-auth-token`, so B is not a boundary. |

### Known gaps (not in this plan)

- **First passkey is trust on first use.** An agent that drives the user's browser can enroll a
  rogue passkey for a user who has none. Users should enroll right after protection is enabled.
- **Member management is not gated.** An admin session can still invite a new account, which
  can enroll its own passkey. Follow-up: require a passkey for invites and admin promotion.
- **Writes are not gated.** An agent can overwrite or delete a protected secret, not read it.
- Passkeys are tied to the host (`rpId`). Moving a self-hosted instance to a new domain means
  enrolling again.

## Open questions (defaults in bold)

1. Hard stop for a grant that stays in use: **24 hours after approval**, or none? With none, an
   agent that reads once an hour keeps access forever.
2. Writes to protected secrets: **no approval**?
3. Command name: **`sigillo access request`**?
4. Session requests approved only by the same user: **yes**?
5. Gate invites and admin promotion with a passkey now or later: **later**?

## Task 1: Prove WebAuthn and session kind in workerd (spike)

- [ ] `@simplewebauthn/server` verifies a registration and an assertion inside the vitest workerd
  pool, using a software authenticator test helper (real P-256 key, no mocks). Pass when one
  test enrolls and asserts against real D1.
- [ ] A session created by `/api/auth/device/token` gets `kind = 'cli'`, an email or OAuth session
  gets `'browser'`. Pass when a test reads both rows. Check if existing device sessions can be
  backfilled by `user_agent` in the migration.

## Task 2: Schema, passkeys, approval engine (sequential, after Task 1)

- [ ] Migration 0011 and schema for the tables above. Pass when `pnpm --dir app dev` boots on a
  fresh local D1 and the Prisma-syntax diff is reported to the user with its own critique URL.
- [ ] Passkey enroll, list, delete and the one assertion helper. Pass when tests show: a CLI
  session cannot enroll, a second passkey needs an assertion, a replayed assertion and an
  assertion made for another action are rejected.
- [ ] Policy, grant check and request creation enforced on every read path in **Rules**. Pass when
  one flow test covers: protect env, 403 with the approval fields, second blocked env joins the
  same request, `POST /approvals` adds an item and replaces the label on it, an approval made
  for the old item set is rejected, approve, reads work, revoke, 403 again. The same test
  checks expiry with no sleep, by moving timestamps into the past: a grant idle for over 1
  hour is rejected, a read refreshes `lastUsedAt`, a browser unlock ends after 1 minute.
- [ ] Bypass regression test. Pass when all fail without a grant: dashboard secrets loader and
  event log return no values, `syncMissingSecretsAction` from a protected env, turning
  protection off without an assertion, a grant of session A used by session B or by a token, an
  approver without access to the env.
- [ ] Per-secret and token cases. Pass when: an open secret reads while a protected one in the
  same env returns 403, `download` lists only the protected names in the request, a token is
  blocked and then approved until revoked.

## Task 3: Dashboard (sequential, after Task 2; parallel with Task 4)

- [ ] Settings cards, Approvals tab with its empty state, approve page, unlock on Secrets and
  Event Log, as in **Dashboard UX**. Pass when playwriter screenshots of each screen at 1280px
  and 390px (light and dark) are in the thread and the user completes one real passkey approval
  on local dev.
- [ ] Mobile pass on touched pages. Pass when the 390px screenshots show no horizontal overflow
  on Settings (Danger Zone rows stack) and the active tab is visible in the tab bar.

## Task 3b: Normal borders site-wide (parallel with every task, touches no feature code)

- [ ] `Frame` and the frame variants of `Table` render a normal border, no muted wrapper and no
  shadow. Pass when playwriter screenshots of Secrets, Environments, Tokens, Access and Event
  Log (light and dark, 1280px and 390px) show one plain border and no clipped corners or
  double lines.

## Task 4: CLI (sequential, after Task 2; parallel with Task 3)

- [ ] Shared `approval_required` handling and `sigillo access request`. Pass when `zig build test`
  covers: 403 body with and without the approval fields, 404 from an old server prints the
  redeploy message, flag parsing; and `pnpm --dir cli install:local` then a real run against
  local dev prints the URL in an agent shell and waits in a TTY.

## Task 5: Docs and release prep (sequential, after Tasks 3 and 4)

- [ ] Docs page for approvals, generated CLI docs, `skills/sigillo/SKILL.md` teaches agents to
  show the URL and rerun, AGENTS.md section with the rules and gaps, one changeset for
  `sigillo-app` and `sigillo`. Pass when every added URL returns 200.

## Done

- [ ] On preview: an admin protects `prod`, an agent shell runs `sigillo run -c prod -- env`, gets
  the URL, the user approves with Touch ID, the rerun prints redacted env. The currently
  published CLI (not updated) shows the URL in its 403 error against the same preview.

## Files

| Area | Files |
| --- | --- |
| Schema | `db/src/app-schema.ts`, `db/drizzle-app/0011_passkey-approvals.sql` |
| Server | new `app/src/passkey.ts`, new `app/src/approvals.ts`, `app/src/db.ts` (session id and kind, device hook), `app/src/api.ts`, `app/src/actions.ts`, `app/src/app.tsx` (routes, loaders, tab, `safeRedirectPath`) |
| UI | `components/settings-page.tsx` (Approvals and Passkeys cards, stacked rows), new `components/approvals-page.tsx` (requests, empty state), new `components/approve-request.tsx`, `secrets-table.tsx`, `project-page.tsx`, `event-log-table.tsx`, `TabBar` in `app.tsx` |
| Deps | `app/package.json`: `@simplewebauthn/server`, `@simplewebauthn/browser` |
| CLI | `cli/zig/src/main.zig`, `cli/zig/src/client.zig`, `cli/scripts/generate-client.ts`, `app/src/openapi.json` |
| Tests | `app/src/app.test.ts`, zig tests in `main.zig` |
| Docs | `app/src/docs/`, `skills/sigillo/SKILL.md`, `AGENTS.md`, `.changeset/passkey-approvals.md` |

Decisions: `plans/decisions/approvals-ui-placement.md`,
`plans/decisions/approval-request-editing.md`, `plans/decisions/dashboard-unlock.md`,
`plans/decisions/approval-expiry.md`. Record the answers to the open questions as decision
files before Task 1.
