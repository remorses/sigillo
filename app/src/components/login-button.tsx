// Client component for the login page sign-in button.
// Uses the type-safe BetterAuth client to trigger the genericOAuth flow.

"use client"

import { useState } from "react"
import { Button } from "sigillo-app/src/components/ui/button"
import { authClient } from "../auth-client.ts"

export function LoginButton({ callbackURL = "/" }: { callbackURL?: string }) {
  const [loading, setLoading] = useState(false)

  async function handleSignIn() {
    setLoading(true)
    await authClient.signIn.oauth2({
      providerId: "sigillo",
      callbackURL,
    })
  }

  return (
    <Button
      onClick={handleSignIn}
      loading={loading}
      size="lg"
    >
      {loading ? "Redirecting…" : "Sign in with Google"}
    </Button>
  )
}
