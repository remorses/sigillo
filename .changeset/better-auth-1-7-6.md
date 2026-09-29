---
'sigillo-app': patch
---

The app and its login provider run on the stable `better-auth` 1.7.6 instead of `1.7.0-beta.4`. The provider gets migration `0003` for the new columns and tables of `@better-auth/oauth-provider` 1.7.6, and local development registers its `http://localhost` callback as a native OAuth client, which 1.7.6 requires.
