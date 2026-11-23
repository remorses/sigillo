---
'sigillo-app': minor
---

**Passkey approvals for secret reads.** A CLI, agent or API token can now be required to get a human approval, confirmed with a passkey, before it reads protected secrets.

- **Settings** has a new **Approvals** card: choose per environment between **Off**, **Selected secrets** and **All secrets**. A new **Passkeys** card manages your passkeys. Nothing is protected until an admin turns it on.
- A blocked read returns `403` with an approval URL. Each session or token has one pending request that it keeps adding to, so you approve everything with one passkey prompt:

```bash
$ sigillo run -c prod -- pnpm deploy
error: approval required
https://sigillo.dev/approve/01KX8Q2M0V7T9C4J6N3R5W1Z8B
Tell the user to open this URL and approve with their passkey. Then wait for them in the background with:
  sigillo access wait 01KX8Q2M0V7T9C4J6N3R5W1Z8B
It exits 0 when they approve. Then run your command again.
```

- New **Approvals** tab lists pending requests and active approvals. **Approve** grants a request in place with one passkey prompt, **Review details** opens the full page, and **Revoke** ends an approval.
- An approval belongs to the session or token that asked and ends 1 hour after its last use. API tokens can be approved until revoked.
- The dashboard asks too: protected values show a lock, and revealing, copying or downloading them asks for your passkey and unlocks that environment for 1 minute.
- New REST routes `POST /api/v0/approvals` and `GET /api/v0/approvals/:id`.

Also in this release:

- Tables use one plain border instead of the padded, shadowed frame.
- Mobile fixes: pages no longer scroll sideways, the Secrets table keeps its key column readable, the active project tab scrolls into view, and Settings rows stack.
