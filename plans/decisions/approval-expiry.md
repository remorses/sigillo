# An approval expires 1 hour after its last use (human)

- User, 2026-11-21: "lets make it expire after one hour since last use please".
- A grant stays valid while it is used. It ends when no protected read used it for 1 hour.
- No duration select on the approve page.
- Why: an agent that keeps working is not interrupted, an idle one loses access, and the user
  has nothing to choose.
- Lost: fixed durations (1h, 8h, 24h) picked at approval.
- (agent) `lastUsedAt` is set at approval and by protected reads, written at most once a minute
  so reads do not cost a D1 write each.
- (agent) API tokens can be approved **until revoked** (`expiry = 'never'`), because CI may run
  less than once an hour.
- (agent) The website unlock is separate: fixed 1 minute, see `dashboard-unlock.md`.
- Open: a hard stop (24 hours after approval) for grants that stay in use. Not decided.
- Lives in: `app/src/approvals.ts`, `db/src/app-schema.ts` (`approval_request`).
