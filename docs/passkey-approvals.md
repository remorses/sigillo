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

It cannot produce a passkey assertion with user verification. So the passkey is the only
boundary. Never treat a cookie session as more trusted than the CLI token.

## Rules for new code

- **Every path that returns a decrypted value or copies ciphertext must check the grant.** Use
  `getLockedNames()` in loaders and actions (never creates a request) and
  `requestReadApproval()` in REST routes (adds to the pending request, caller answers 403).
  Today: `GET secrets/:name`, `GET secrets/download`, the secrets page loader, the event log
  loader, `syncMissingSecretsAction`, `unlockEnvironmentAction`.
- **Anything that lowers protection or hands out access needs `requirePasskey()`** with its own
  `PasskeyIntent`. Raising protection, deny and revoke do not.
- **A grant never transfers.** It is bound to `sessionId` or `apiTokenId`. The FKs are
  `ON DELETE SET NULL`: a deleted credential leaves a dead audit row, never a wider grant.
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
- **First passkey = trust on first use.** It needs `session.kind = 'browser'`. Device-flow
  sessions are marked `cli` by the `session.create` hook in `db.ts`. "First" counts passkeys on
  every host, because one instance can answer on several hosts that share grants.
- Later passkeys and removals need an assertion from an existing passkey.
- Passkeys are bound to the host (`rpId`). A domain move needs the `passkey` rows of the old
  host deleted by hand.

## Known gaps

- An agent that drives the browser of a user with **no passkey** can enroll its own. Enroll
  right after turning approvals on.
- Member management is not gated: an admin session can invite an account that enrolls its own
  passkey. Follow-up: require a passkey for invites and admin promotion.
- Writes are not gated: an agent can overwrite or delete a protected secret.
- A grant in constant use has no hard stop (open decision in
  `plans/decisions/approval-expiry.md`).

## Testing

`app/src/approvals.test.ts` has a software authenticator (real P-256 key, real WebAuthn
verification, no mocks). Typecheck and build do not catch a missing gate: add the new path to
the bypass assertions there.
