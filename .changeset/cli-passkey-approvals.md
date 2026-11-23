---
'sigillo': minor
---

The CLI now handles passkey approvals for protected secrets.

- `run`, `secrets get` and `secrets download` print the approval URL when a read needs approval. In a terminal they open the browser, wait until you approve, then retry. In agent shells and scripts they exit at once, so the agent can show the URL.
- New `sigillo access request` asks for everything up front. Running it again adds to the same request and prints the same URL:

```bash
sigillo access request -c dev -c prod --label 'Deploy website'
sigillo access request -c prod --secret STRIPE_KEY
```

- New `sigillo access wait` blocks until the request is approved or denied, so an agent does not poll. It exits 0 when approved. A blocked command prints the exact line to run:

```bash
$ sigillo run -c prod -- pnpm deploy
error: approval required
https://sigillo.dev/approve/01KX8Q2M0V7T9C4J6N3R5W1Z8B
Tell the user to open this URL and approve with their passkey. Then wait for them in the background with:
  sigillo access wait 01KX8Q2M0V7T9C4J6N3R5W1Z8B
It exits 0 when they approve. Then run your command again.
```

Against a server without approvals, `access request` and `access wait` say the server must be redeployed. Other commands work as before.
