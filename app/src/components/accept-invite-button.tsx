// Client component for accepting an org invitation.
// Shown on the /invite/:id page after the user logs in.

"use client"

import { ErrorBoundary } from "spiceflow/react"
import { Button } from "sigillo-app/src/components/ui/button"
import { acceptInviteAction } from "../actions.ts"

export function AcceptInviteButton({ invitationId }: { invitationId: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <ErrorBoundary
        fallback={
          <div className="flex flex-col items-center gap-2">
            <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
            <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer">
              Try again
            </ErrorBoundary.ResetButton>
          </div>
        }
      >
        <form action={async () => {
          await acceptInviteAction({ invitationId })
        }}>
          <Button type="submit">Join organization</Button>
        </form>
      </ErrorBoundary>
    </div>
  )
}
