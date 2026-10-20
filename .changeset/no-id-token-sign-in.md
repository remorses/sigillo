---
'sigillo-app': patch
---

Neither the app nor its login provider signs anyone in with a raw `id_token` any more. Both stored the last one in D1 as is, so it could be replayed while still valid. Signing in always goes through the redirect.
