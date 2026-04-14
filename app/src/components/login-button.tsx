// Client component for the login page sign-in button.
// Uses the type-safe BetterAuth client to trigger the genericOAuth flow.

"use client"

import { useState } from "react"
import { authClient } from "../auth-client.ts"

export function LoginButton() {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    await authClient.signIn.oauth2({
      providerId: "sigillo",
      callbackURL: "/",
    })
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
