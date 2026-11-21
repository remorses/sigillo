# The website asks for a passkey to reveal protected secrets, cached 1 minute (human asked)

- User, 2026-11-21: "should the website itself ask for passkeys to show secrets to the user
  itslef? think. and cache approval for some time like 1 minute. to make a secret visible"
- (agent) **Yes, the website asks.** Without it the protection has no effect:
  - The CLI login token is a normal session. With `Authorization: Bearer` it loads the dashboard
    secrets page, which returns decrypted values.
  - Agents can drive the user's logged-in browser (playwriter, CDP). A cookie is not proof of a
    human; a passkey with user verification is.
- The unlock is a grant for the **browser session and one environment**, fixed at **1 minute**.
- (agent) The prompt sits on the existing reveal actions (eye icon, Show all secrets, Copy as
  .env, copy missing secrets). No banner, no extra page.
- (agent) Values already on screen stay after the minute. They are masked again when the page
  loads data again. Editing a secret needs no unlock.
- Why 1 minute: long enough to reveal and copy, short enough that an agent driving the same
  browser has almost no window to reuse the unlock.
- Lost: a long browser unlock (the user chose a short cache), and reading protected values in
  the dashboard without a passkey.
- Open: none.
- Lives in: `app/src/app.tsx` (secrets and event log loaders), `app/src/actions.ts`,
  `app/src/components/secrets-table.tsx`, `app/src/components/event-log-table.tsx`.
