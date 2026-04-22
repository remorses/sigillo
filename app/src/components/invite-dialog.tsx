// Client component for generating and displaying org invite links.
// Shows a dialog with a "Generate invite link" button. Once generated,
// displays the link with a copy button. The link grants access to ALL
// projects in the organization, not just the current one.

"use client"

import { useState } from "react"
import { router } from "spiceflow/react"
import { createInviteAction } from "../actions.ts"
import { Button } from "sigillo-app/src/components/ui/button"
import {
  Dialog, DialogPopup, DialogHeader, DialogTitle,
  DialogDescription, DialogClose, DialogFooter,
} from "sigillo-app/src/components/ui/dialog"
import { LinkIcon, CopyIcon, CheckIcon, UserPlusIcon } from "lucide-react"
import { Input } from "sigillo-app/src/components/ui/input"

export function InviteButton({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <UserPlusIcon className="size-4" />
        Invite member
      </Button>
      <InviteDialog open={open} onOpenChange={setOpen} orgId={orgId} />
    </>
  )
}

function InviteDialog({ open, onOpenChange, orgId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgId: string
}) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const result = await createInviteAction({ orgId })
      setInviteUrl(`${window.location.origin}${router.href('/invite/:id', { id: result.id })}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate invite link')
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy() {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setInviteUrl(null)
      setCopied(false)
      setError(null)
    }
    onOpenChange(open)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            Generate a link to invite someone to this organization.
            Anyone with the link can join <strong>all projects</strong> in this organization — not just the current project. The link expires in 7 days.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-2">
          {error && (
            <p className="text-sm text-destructive mb-3">{error}</p>
          )}
          {inviteUrl ? (
            <div className="flex flex-col gap-3">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={inviteUrl}
                  className="w-full font-mono text-xs"
                  onClick={(e) => e.currentTarget.select()}
                />
                <Button variant="outline" size="icon" onClick={handleCopy}>
                  {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Share this link with the person you want to invite. They'll need to sign in first.
              </p>
            </div>
          ) : (
            <Button onClick={handleGenerate} loading={loading} className="w-full">
              <LinkIcon className="size-4" />
              Generate invite link
            </Button>
          )}
          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              {inviteUrl ? "Done" : "Cancel"}
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
