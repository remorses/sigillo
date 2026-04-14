// Client component for the OAuth consent page.
// POSTs JSON to BetterAuth's consent endpoint and follows the redirect.

"use client"

import { useState } from "react"

export function ConsentButtons() {
  const [loading, setLoading] = useState(false)

  async function handleConsent(accept: boolean) {
    setLoading(true)
    try {
      // BetterAuth requires the signed OAuth query params from the current URL.
      // The oauthProviderClient normally handles this, but we pass it manually.
      const oauthQuery = window.location.search.slice(1)
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, oauth_query: oauthQuery }),
        redirect: "follow",
      })
      // BetterAuth returns a redirect URL in the response
      if (res.redirected) {
        window.location.href = res.url
        return
      }
      const data = (await res.json()) as { url?: string; redirectTo?: string }
      if (data.url || data.redirectTo) {
        window.location.href = (data.url || data.redirectTo)!
      }
    } catch {
      setLoading(false)
    }
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
