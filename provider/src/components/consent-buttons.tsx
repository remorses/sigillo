// Client component for the OAuth consent page.
// Uses the type-safe BetterAuth client with oauthProviderClient plugin
// which automatically sends oauth_query from the current URL.

"use client"

import { useState } from "react"
import { authClient } from "../auth-client.ts"

export function ConsentButtons() {
  const [loading, setLoading] = useState(false)
  const buttonClassName = 'inline-flex min-h-11 items-center justify-center rounded-xl border px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60'

  async function handleConsent(accept: boolean) {
    setLoading(true)
    // oauthProviderClient plugin automatically includes oauth_query
    // from the signed query params in the current URL
    await authClient.oauth2.consent({ accept })
  }

  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <button
        className={`${buttonClassName} border-border bg-transparent text-foreground hover:bg-secondary`}
        onClick={() => handleConsent(false)}
        disabled={loading}
      >
        Deny
      </button>
      <button
        className={`${buttonClassName} border-primary bg-primary text-primary-foreground shadow-sm hover:opacity-90`}
        onClick={() => handleConsent(true)}
        disabled={loading}
      >
        {loading ? "Redirecting…" : "Allow access"}
      </button>
    </div>
  )
}
