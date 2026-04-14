// Client component for the provider sign-in page.
// Uses the type-safe BetterAuth client to trigger Google social sign-in.

"use client"

import { useState } from "react"
import { authClient } from "../auth-client.ts"

export function GoogleSignInButton() {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    await authClient.signIn.social({
      provider: "google",
      // Preserve the full current URL (including OAuth query params) so
      // BetterAuth can resume the authorization flow after Google login.
      callbackURL: window.location.href,
    })
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
