// Type-safe BetterAuth client for the provider.
// Used by client components (sign-in, consent) to call auth endpoints
// with correct types, content-type, and automatic oauth_query handling.

import { createAuthClient } from 'better-auth/client'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'

export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
})
