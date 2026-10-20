---
'sigillo-app': patch
---

A session token copied out of the database no longer signs anyone in.

- Bearer tokens must carry the signature that only the Worker's `BETTER_AUTH_SECRET` can make, as the session cookie already does, and `sigillo login` now receives such a signed token. **CLI logins from before this update stop working: run `sigillo login` once.**
- The OAuth tokens that the app and its login provider store are encrypted in D1.
- A request without a valid session gets `not signed in, or the session expired: run sigillo login` instead of `unauthorized`.
