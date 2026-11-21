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

Against a server without approvals, `access request` says the server must be redeployed. Other commands work as before.
