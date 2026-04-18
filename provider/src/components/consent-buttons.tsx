// Client component for the OAuth consent page.
// Uses the type-safe BetterAuth client with oauthProviderClient plugin
// which automatically sends oauth_query from the current URL.

"use client"

import { useState } from "react"
import { authClient } from "../auth-client.ts"

export function ConsentButtons() {
  const [loading, setLoading] = useState(false)

  async function handleConsent(accept: boolean) {
    setLoading(true)
    // oauthProviderClient plugin automatically includes oauth_query
    // from the signed query params in the current URL
    await authClient.oauth2.consent({ accept })
  }

  return (
    <div className="consent-buttons">
      <button
        className="consent-button consent-button-deny"
        onClick={() => handleConsent(false)}
        disabled={loading}
      >
        Deny
      </button>
      <button
        className="consent-button consent-button-allow"
        onClick={() => handleConsent(true)}
        disabled={loading}
      >
        {loading ? "Redirecting…" : "Allow access"}
      </button>
    </div>
  )
}
