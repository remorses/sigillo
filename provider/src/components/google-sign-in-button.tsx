// Client component for the provider sign-in page.
// POSTs to BetterAuth's social sign-in endpoint and redirects to Google OAuth.

"use client"

import { useState } from "react"

export function GoogleSignInButton() {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    try {
      const res = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Preserve the full current URL (including OAuth query params) as the
        // callback so BetterAuth can resume the authorization flow after login.
        body: JSON.stringify({ provider: "google", callbackURL: window.location.href }),
      })
      const data = (await res.json()) as { url?: string }
      if (data.url) {
        window.location.href = data.url
      }
    } catch {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleSignIn}
      disabled={loading}
      style={{
        display: "inline-block",
        padding: "12px 24px",
        background: "#4285f4",
        color: "white",
        borderRadius: 8,
        border: "none",
        cursor: "pointer",
        fontWeight: 600,
        fontSize: 16,
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "Redirecting…" : "Sign in with Google"}
    </button>
  )
}
