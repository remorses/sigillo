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
    <>
      <button
        onClick={() => handleConsent(true)}
        disabled={loading}
        style={{
          padding: "10px 20px",
          background: "#22c55e",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          fontWeight: 600,
          opacity: loading ? 0.6 : 1,
        }}
      >
        Allow
      </button>
      <button
        onClick={() => handleConsent(false)}
        disabled={loading}
        style={{
          padding: "10px 20px",
          background: "#ef4444",
          color: "white",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
          fontWeight: 600,
          opacity: loading ? 0.6 : 1,
        }}
      >
        Deny
      </button>
    </>
  )
}
