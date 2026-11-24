---
'sigillo-app': patch
---

Update Better Auth from `1.7.0-beta.4` to the stable `1.7.28` in the app and the sign-in provider, and switch to the official Drizzle adapter (`@better-auth/drizzle-adapter/relations-v2`).

The session cookie cache works again after the update: Better Auth 1.7 rejects cached sessions whose dates are numbers, so auth tables now read dates as `Date`. No app database migration is needed.

The sign-in provider gets one additive migration for the new OAuth provider tables and columns, and keeps accepting `http://localhost` callbacks for local development.
