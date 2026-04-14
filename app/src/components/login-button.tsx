// Client component for the login page sign-in button.
// Calls BetterAuth's genericOAuth sign-in endpoint which returns a redirect
// URL to the provider, then navigates the browser there.

"use client"

import { useState } from "react"

export function LoginButton() {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    try {
      const res = await fetch("/api/auth/sign-in/oauth2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: "sigillo",
          callbackURL: "/",
        }),
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
      className="h-10 px-6 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
    >
      {loading ? "Redirecting…" : "Sign in with Google"}
    </button>
  )
}
