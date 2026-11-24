---
title: Passkey approvals for secret reads
description: Rules, threat model and code map for the approval gate on protected secrets. Read before touching any code path that decrypts a secret or changes approval settings.
---

# Passkey approvals for secret reads

A session or API token must hold a **grant** before it reads a protected secret. A grant is an
approval request that a human confirmed with a passkey. User docs: `app/src/docs/approvals.mdx`.

```
 blocked read ──▶ pending approval_request (one per credential, agents edit it)
                        │
                        │ human opens /approve/<id>, passkey assertion bound to the item ids
                        ▼
                  status = approved  ──▶ grant for THAT credential only
                        │
                        ├── ends 1 hour after lastUsedAt (expiry = 'idle')
                        ├── never ends (expiry = 'never', API tokens only)
                        └── ends at grantExpiresAt (website unlock, 1 minute)
```

## Threat model

The attacker is an AI agent on the user's machine. It can:

- read the CLI session token from `~/.sigillo/config.json`. That token is a **normal BetterAuth
  session**: sent as `Authorization: Bearer` it works on every route, also dashboard page
  loaders and server actions.
- drive the user's **logged-in browser** (playwriter, CDP).

It can generate a software authenticator and set its user-verification flag. Registration
therefore proves possession of a key, not a human's presence.

The boundary is an **exact credential trusted by the organization** on a device the human
controls. An attacker cannot sign with that credential. Never treat a cookie session as more
trusted than a CLI token. Initial setup on an already compromised device is not secure.

## Rules for new code

- **Every path that returns a decrypted value or copies ciphertext must check the grant.** Use
  `getLockedNames()` in loaders and actions (never creates a request) and
  `requestReadApproval()` in REST routes (adds to the pending request, caller answers 403).
  Today: `GET secrets/:name`, `GET secrets/download`, the secrets page loader, the event log
  loader, `syncMissingSecretsAction`, `unlockEnvironmentAction`.
- **Anything that lowers protection needs an org-trusted `requirePasskey()` assertion.**
  Access-expanding changes use `guardAccessChange()` once org protection is configured. It
  returns a condition that the write must include.
- **Every gated action has its own typed intent** in `passkeyIntentSchema`. The browser and the
  server build the same object; never sign a hand-built string.
  Raising protection requires an already-trusted key. Deny and revoke do not need an assertion.
- **A grant never transfers.** It is bound to `sessionId` or `apiTokenId`. The FKs are
  `ON DELETE SET NULL`: a deleted credential leaves a dead audit row, never a wider grant.
- **Never return another session's token.** better-auth's `/list-sessions` does, so `getAuth()`
  disables it. With that token a CLI session could act as the browser session and use its grants.
- **Names on the approve page need a passkey to change.** While an environment is protected,
  renaming it, changing its slug, deleting it, or renaming its project calls `requirePasskey()`.
  REST refuses these changes: it cannot carry an assertion. Otherwise the requester renames
  `Production` to `Development` before it asks. The environment description stays free.
- **`''` as `approval_item.secret_name` means every secret of the environment.** It is only
  created for a whole-environment read in an `all` environment.
- **The 403 body is a CLI contract.** `error` (human text with the URL, the only field old CLIs
  print), `code: 'approval_required'`, `approvalId`, `approvalUrl`. Keep the fields flat.
- **The label is untrusted.** It is written by the requester. Show it as a quote, never as a
  title or as HTML.

## Passkeys

`app/src/passkey.ts` uses `@simplewebauthn/server` directly. Do not switch to
`@better-auth/passkey`: it lets any session add a passkey, has no assertion bound to a custom
payload, and adds passkey sign-in.

- A challenge is stored in the BetterAuth `verification` table with the serialized intent it
  was issued for. It is single use and lives 5 minutes.
- **Registration does not grant authority.** Organization trust is a separate relationship
  between an org and an exact registered credential.
- **Initial setup is explicit.** Before any environment is protected, an admin selects their
  exact key and signs the setup intent. The human must do this on a device they trust.
  The server cannot detect a real human or distinguish a software key.
- **Later trust needs a trusted admin key.** The assertion names the exact candidate passkey.
  New members and new keys cannot approve until an admin trusts that key.
- **Trust is org-specific.** A cross-org request needs a credential trusted in every org
  included in the grant. Normal member and environment access checks still apply.
- **Setup never resets automatically.** Deleting the last trusted key does not allow another
  first-key setup. Existing protected orgs are not backfilled with trust.
- **The last trusted admin stays.** Removing or demoting the last admin with an org-trusted
  passkey fails: trust another admin's credential first. Other access reductions are allowed.
- Initial setup cancels older invitations and disables domain auto-join. New access-expanding
  invitations, promotions, project grants, environment roles, and domain auto-join need a
  trusted admin assertion bound to the exact change.
- Passkeys are bound to the host (`rpId`). A domain move needs the `passkey` rows of the old
  host deleted by hand.

## Recovery

An organization with protected environments and no trusted key stays locked. This includes
older deployments upgraded without trusted setup. Do not disable protection or trust every
existing key as a migration shortcut.

The trust migration revokes grants issued under the previous registration-only model.

It also marks **every existing session as `cli`**. Migration 0011 added `session.kind` with
default `browser`, so CLI device logins made before it looked like browser sessions. Their kind
cannot be recovered, so all old sessions lose registration and setup. Browser users sign out
and sign in again after the upgrade; the new session is `browser`. CLI logins keep working.

An instance operator must verify the admin and the exact replacement credential outside the
compromised session before a deliberate database repair. There is no session-only reset.
On hosted Sigillo, contact the operator. Keep a second trusted admin key before you lose one.

## Known limits

- Initial setup depends on the human using a trusted device before protection starts.
- Trust is checked when an action is authorized. Removing a key does not undo earlier grants
  or settings. Revoke existing grants separately when a key is compromised.
- Writes are not gated: an agent can overwrite or delete a protected secret. It can also delete
  a whole project or organization.
- The passkey prompt of the OS does not show the intent. An agent that controls the page when
  the human touches the sensor can ask for a different intent, also `trust-passkey` for its own
  key. Approve only in a browser that no agent drives.
- A grant in constant use has no hard stop (open decision in
  `plans/decisions/approval-expiry.md`).

## Testing

`app/src/approvals.test.ts` has a software authenticator (real P-256 key, real WebAuthn
verification, no mocks). Typecheck and build do not catch a missing gate: add the new path to
the bypass assertions there. `app/src/migrations.test.ts` replays data migration statements on
legacy rows.
