// The page behind the URL a CLI or agent prints: /approve/:id.
// Shows who asks for which secrets and lets the human approve everything
// that is checked with one passkey prompt, or deny.
//
// The label is text written by the requester (an agent), so it is shown as a
// quote. The item list is what the user approves.

'use client'

import { useState, useTransition } from 'react'
import { CheckIcon } from 'lucide-react'
import { Button } from 'sigillo-app/src/components/ui/button'
import { cn } from 'sigillo-app/src/lib/utils'
import { canSignItems, groupRequestItems, requesterTitle } from 'sigillo-app/src/components/approvals-page'
import { confirmWithPasskey, passkeyErrorMessage } from 'sigillo-app/src/components/passkey'
import { approveRequestAction, denyRequestAction } from '../approval-actions.ts'

type Item = {
  id: string
  environmentId: string
  environmentName: string
  projectName: string
  secretName: string
  allowed: boolean
  // The viewer's passkeys that the organization of this item trusts.
  trustedKeyIds: string[]
}

// Why the viewer cannot approve this item, or null.
function blockedReason(item: Item) {
  if (!item.allowed) return 'no access'
  if (item.trustedKeyIds.length === 0) return 'no trusted passkey'
  return null
}

type RequestView = {
  id: string
  state: 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'
  requester: { kind: 'token' | 'cli' | 'browser' | 'gone'; name: string }
  label: string
  createdAt: number
  createdAtLabel: string
  userAgent: string | null
  items: Item[]
}

const CLOSED_TEXT = {
  approved: { title: 'Approved', text: 'Run the command again. Access ends 1 hour after the last use.' },
  denied: { title: 'Denied', text: 'The request was rejected. You can close this page.' },
  revoked: { title: 'Revoked', text: 'This approval was revoked. Run the command again to ask for a new one.' },
  expired: { title: 'Expired', text: 'This request expired. Run the command again to get a new link.' },
} as const

export function ApproveRequest({ request }: { request: RequestView }) {
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({})
  const [keep, setKeep] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (request.state !== 'pending') {
    const closed = CLOSED_TEXT[request.state]
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="max-w-sm text-center text-balance">
          <h1 className="mb-2 text-2xl font-bold">{closed.title}</h1>
          <p className="text-muted-foreground">{closed.text}</p>
        </div>
      </div>
    )
  }

  const selected = request.items.filter((item) => !blockedReason(item) && !unchecked[item.id])
  const itemIds = selected.map((item) => item.id)
  const canSign = canSignItems(selected)
  const needsTrust = request.items.some((item) => blockedReason(item) === 'no trusted passkey')
  const isToken = request.requester.kind === 'token'

  function run(action: () => Promise<unknown>) {
    setError(null)
    startTransition(async () => {
      try {
        await action()
      } catch (e) {
        setError(passkeyErrorMessage(e))
      }
    })
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 px-4 py-10 sm:py-16">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approve secret access?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {requesterTitle(request.requester)} asks to read secrets. Asked{' '}
          <time dateTime={new Date(request.createdAt).toISOString()}>{request.createdAtLabel}</time>.
        </p>
        {request.userAgent && <p className="mt-1 text-xs text-muted-foreground break-words">{request.userAgent}</p>}
        {request.label && (
          <p className="mt-3 border-l-2 border-border pl-3 text-sm break-words">
            "{request.label}"
            <span className="block text-xs text-muted-foreground">Note written by the requester</span>
          </p>
        )}
      </div>

      <div className="rounded-lg border border-border bg-background overflow-hidden">
        {groupRequestItems(request.items).map((group) => (
          <div key={group.environmentId} className="border-b border-border last:border-b-0">
            <p className="bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
              {group.projectName} · <span className="font-medium text-foreground">{group.environmentName}</span>
            </p>
            {group.items.map((item) => {
              const blocked = blockedReason(item)
              const checked = !blocked && !unchecked[item.id]
              return (
                <label
                  key={item.id}
                  className={cn(
                    'flex min-h-11 items-center gap-3 border-t border-border px-4 py-2 text-sm',
                    blocked ? 'opacity-60' : 'cursor-pointer',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                      checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                    )}
                  >
                    {checked && <CheckIcon className="size-3" />}
                  </span>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    disabled={!!blocked || isPending}
                    onChange={() => setUnchecked((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                  />
                  {item.secretName === ''
                    ? <span>All secrets</span>
                    : <span className="mono-sm break-all">{item.secretName}</span>}
                  {blocked && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{blocked}</span>}
                </label>
              )
            })}
          </div>
        ))}
      </div>

      {isToken ? (
        <label className="flex cursor-pointer items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-(--primary)"
            checked={keep}
            disabled={isPending}
            onChange={(e) => setKeep(e.currentTarget.checked)}
          />
          <span>
            Keep until revoked
            <span className="block text-xs text-muted-foreground">
              For CI that runs less than once an hour. Otherwise access ends 1 hour after the last use.
            </span>
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">Access ends 1 hour after the last use. You can revoke it in the Approvals tab.</p>
      )}

      {needsTrust && (
        <p className="text-xs text-muted-foreground">
          The organization of an item marked "no trusted passkey" trusts none of your passkeys.
          Ask an admin there to trust one in Settings.
        </p>
      )}
      {selected.length > 0 && !canSign && (
        <p className="text-xs text-muted-foreground">
          No single passkey of yours is trusted by every organization in this selection.
          Uncheck items, approve the rest, then run the command again for what is left.
        </p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          variant="outline"
          size="lg"
          disabled={isPending}
          onClick={() => run(() => denyRequestAction({ requestId: request.id }))}
        >
          Deny
        </Button>
        <Button
          size="lg"
          loading={isPending}
          disabled={!canSign}
          onClick={() => run(async () => {
            const assertion = await confirmWithPasskey({ kind: 'approve', requestId: request.id, itemIds, keep })
            await approveRequestAction({
              requestId: request.id, itemIds, seenItemIds: request.items.map((item) => item.id), keep, assertion,
            })
          })}
        >
          Approve with passkey
        </Button>
      </div>
    </div>
  )
}
