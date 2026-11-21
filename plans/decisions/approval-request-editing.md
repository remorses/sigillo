# Agents label and edit one pending approval request (human)

- User, 2026-11-21: "so agents now support lablling an approval right? also let them edit. so
  they can batch approvals editing same one. instead of creating many new ones."
- A credential (session or API token) has at most **one pending request**. Every new need edits
  it: a blocked read adds its item, `sigillo access request` adds items and sets the label.
  The URL stays the same.
- The request has a **label** written by the requester, max 200 chars.

```bash
sigillo access request -c prod --label 'Deploy website'   # creates the request, prints the URL
sigillo access request -c dev --secret STRIPE_KEY         # edits it, prints the same URL
```

- Why: the user approves once, with one passkey prompt, for everything the agent needs.
- Lost: several independent requests per credential, and removing items from the CLI (the user
  unchecks items on the approve page instead).
- (agent) The label is untrusted text. The approve page shows it as a quoted note, never as the
  title. The item list is what the user approves.
- (agent) The assertion is bound to the exact items shown. If the request was edited after the
  page loaded, approval fails and the page reloads.
- Open: none.
- Lives in: `app/src/approvals.ts`, `app/src/api.ts` (`POST /api/v0/approvals`),
  `cli/zig/src/main.zig` (`access request`).
