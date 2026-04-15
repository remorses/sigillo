// Client component for accepting an org invitation.
// Shown on the /invite/:id page after the user logs in.

"use client"

import { useState } from "react"
import { useRouter } from "spiceflow/react"
import { acceptInviteAction } from "../actions.ts"

export function AcceptInviteButton({ invitationId }: { invitationId: string }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  async function handleAccept() {
    setLoading(true)
    setError(null)
    try {
      const result = await acceptInviteAction({ invitationId })
      router.push(`/orgs/${result.orgId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to join organization")
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={handleAccept}
        disabled={loading}
        className="h-10 px-6 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
      >
        {loading ? "Joining…" : "Join organization"}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
