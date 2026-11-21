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
import { TimeAgo } from 'sigillo-app/src/components/ui/time-ago'
import { cn } from 'sigillo-app/src/lib/utils'
import { groupRequestItems, requesterTitle } from 'sigillo-app/src/components/approvals-page'
import { confirmWithPasskey, enrollPasskey, passkeyErrorMessage } from 'sigillo-app/src/components/passkey'
import { approveRequestAction, denyRequestAction } from '../approval-actions.ts'

type Item = {
  id: string
  environmentId: string
  environmentName: string
  projectName: string
  secretName: string
  allowed: boolean
}

type RequestView = {
  id: string
  state: 'pending' | 'approved' | 'denied' | 'revoked' | 'expired'
  requester: { kind: 'token' | 'cli' | 'browser' | 'gone'; name: string }
  label: string
  createdAt: number
  userAgent: string | null
  items: Item[]
}

const CLOSED_TEXT = {
  approved: { title: 'Approved', text: 'Run the command again. Access ends 1 hour after the last use.' },
  denied: { title: 'Denied', text: 'The request was rejected. You can close this page.' },
  revoked: { title: 'Revoked', text: 'This approval was revoked. Run the command again to ask for a new one.' },
  expired: { title: 'Expired', text: 'This request expired. Run the command again to get a new link.' },
} as const

export function ApproveRequest({ request, hasPasskey }: { request: RequestView; hasPasskey: boolean }) {
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({})
  const [keep, setKeep] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (request.state !== 'pending') {
    const closed = CLOSED_TEXT[request.state]
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <h1 className="mb-2 text-2xl font-bold">{closed.title}</h1>
          <p className="text-muted-foreground">{closed.text}</p>
        </div>
      </div>
    )
  }

  const itemIds = request.items.filter((item) => item.allowed && !unchecked[item.id]).map((item) => item.id)
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
          {requesterTitle(request.requester)} asks to read secrets. Asked <TimeAgo ts={request.createdAt} />.
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
              const checked = item.allowed && !unchecked[item.id]
              return (
                <label
                  key={item.id}
                  className={cn(
                    'flex min-h-11 items-center gap-3 border-t border-border px-4 py-2 text-sm',
                    item.allowed ? 'cursor-pointer' : 'opacity-60',
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
                    disabled={!item.allowed || isPending}
                    onChange={() => setUnchecked((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
                  />
                  {item.secretName === ''
                    ? <span>All secrets</span>
                    : <span className="mono-sm break-all">{item.secretName}</span>}
                  {!item.allowed && <span className="ml-auto text-xs text-muted-foreground">no access</span>}
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

      <p className="text-sm text-muted-foreground">
        Approve only if <strong className="text-foreground">you</strong> or your agent started this. If someone sent you this link, deny it.
      </p>

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
          disabled={itemIds.length === 0}
          onClick={() => run(async () => {
            if (!hasPasskey) await enrollPasskey({ hasPasskey: false })
            const assertion = await confirmWithPasskey({ kind: 'approve', requestId: request.id, itemIds, keep })
            await approveRequestAction({
              requestId: request.id, itemIds, seenItemIds: request.items.map((item) => item.id), keep, assertion,
            })
          })}
        >
          {hasPasskey ? 'Approve with passkey' : 'Add a passkey and approve'}
        </Button>
      </div>
    </div>
  )
}
