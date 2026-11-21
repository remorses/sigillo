# Approval config lives in Settings, the Approvals tab only lists requests (human)

- User, 2026-11-21: "lets put approval config and passkeys in settings. and show only link in
  approvals page so it is more minimal. and nice epty state here. make it look good in mobile
  as well. if needed fix other parts of site as well. layout etc."
- **Settings page** holds two cards: **Approvals** (one select per environment: Off, Selected
  secrets, All secrets) and **Passkeys** (the user's passkeys, add and remove).
- **Approvals tab** shows only pending requests and active grants, plus one link to Settings.
- With no requests the tab shows an empty state (`EmptyState`) with a button to Settings.
- User, 2026-11-21, on a mock with the empty state inside a bordered frame: "i dont like this
  border shit". The empty state sits directly on the page: no frame, no border, no boxed hint.
- User, 2026-11-21: "changed all the weird shadowed borders. to be normal borders like in
  approvals". Every container on the site uses a normal 1px border like the Settings cards.
  The `Frame` look (muted padded wrapper, shadowed inner panel) is removed everywhere, not only
  on the new screens.
- Every new screen must look good at 390px. Layout problems found on touched pages are fixed
  in the same work, not left for later.
- Why: the tab is opened to approve, so it stays minimal. Configuration is rare and belongs
  with the other project settings.
- Lost: one page with policy, requests and passkeys together.
- Open: none.
- Lives in: `app/src/components/settings-page.tsx`, `app/src/components/approvals-page.tsx`,
  `app/src/components/ui/frame.tsx`, `app/src/components/ui/table.tsx`.
- (agent) Protection is decided per environment: `environment.readApproval` is `off`,
  `selected` (names in `secret_approval` rows) or `all`. No project-wide switch. The user asked
  "decide per env? per secret? per project?", saw this in a mock and did not change it.
