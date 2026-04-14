// Type-safe BetterAuth client for the self-hosted app.
// Used by client components (login button) to call auth endpoints.

import { createAuthClient } from 'better-auth/client'
import { genericOAuthClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
})
