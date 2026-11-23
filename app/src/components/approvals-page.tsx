// Approvals tab: pending approval requests and live grants for this project.
// What is protected is configured in Settings, this page only links there.
//
// A pending row approves everything it shows with one passkey prompt. The
// "Review details" link opens /approve/:id for the finer choices: uncheck
// single secrets, deny, or keep an API token approved until revoked.

'use client'

import { useState, useTransition } from 'react'
import { SettingsIcon, ShieldCheckIcon } from 'lucide-react'
import { Link, router, useLoaderData } from 'spiceflow/react'
import { ProjectTitle } from 'sigillo-app/src/components/sidebar'
import { Badge } from 'sigillo-app/src/components/ui/badge'
import { Button } from 'sigillo-app/src/components/ui/button'
import { EmptyState } from 'sigillo-app/src/components/ui/empty-state'
import { TimeAgo } from 'sigillo-app/src/components/ui/time-ago'
import { confirmWithPasskey, passkeyErrorMessage } from 'sigillo-app/src/components/passkey'
import { approveRequestAction, revokeRequestAction } from '../approval-actions.ts'

// "Prod: all secrets", "Preview: NPM_TOKEN, STRIPE_KEY". One line per environment.
export function groupRequestItems<T extends { environmentId: string; environmentName: string; projectName: string }>(items: T[]) {
  const groups = new Map<string, { environmentName: string; projectName: string; items: T[] }>()
  for (const item of items) {
    const group = groups.get(item.environmentId) ?? { environmentName: item.environmentName, projectName: item.projectName, items: [] }
    group.items.push(item)
    groups.set(item.environmentId, group)
  }
  return [...groups.entries()].map(([environmentId, group]) => ({ environmentId, ...group }))
}

export function requesterTitle(requester: { kind: 'token' | 'cli' | 'browser' | 'gone'; name: string }) {
  if (requester.kind === 'token') return <>API token <span className="font-semibold">{requester.name}</span></>
  if (requester.kind === 'cli') return <span className="font-semibold">{requester.name}'s CLI session</span>
  if (requester.kind === 'browser') return <span className="font-semibold">{requester.name}'s browser session</span>
  return <span className="font-semibold">A deleted session</span>
}

function useApprovals() {
  return useLoaderData('/dash/projects/:projectId/approvals')
}

export function ApprovalsPage() {
  const { projectId } = useLoaderData('/dash/projects/:projectId/*')
  const { requests, hasProtection, hasPasskey } = useApprovals()
  const settingsHref = router.href('/dash/projects/:projectId/settings', { projectId })

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <ProjectTitle />
        <Link
          href={settingsHref}
          className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground no-underline hover:text-foreground"
        >
          <SettingsIcon className="size-3.5" />
          <span className="sm:hidden">Settings</span>
          <span className="hidden sm:inline">Configure in Settings</span>
        </Link>
      </div>

      {requests.length === 0 ? (
        <EmptyState
          icon={<ShieldCheckIcon className="size-6 text-muted-foreground" />}
          title="No approval requests"
          description="When a CLI or agent needs a protected secret, its request shows up here for you to approve with a passkey."
        >
          <Button size="sm" variant={hasProtection ? 'outline' : 'default'} render={<Link href={settingsHref} />}>
            {hasProtection ? 'Settings' : 'Choose protected secrets'}
          </Button>
        </EmptyState>
      ) : (
        <div className="rounded-lg border border-border bg-background overflow-hidden">
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} projectId={projectId} hasPasskey={hasPasskey} />
          ))}
        </div>
      )}
    </>
  )
}

function RequestRow({ request, projectId, hasPasskey }: {
  request: ReturnType<typeof useApprovals>['requests'][number]
  projectId: string
  hasPasskey: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const isPendingRequest = request.status === 'pending'
  const reviewHref = router.href('/approve/:id', { id: request.id })
  const itemIds = request.items.map((item) => item.id)
  // Items the user cannot approve are only handled on the review page.
  const canApproveAll = request.items.every((item) => item.allowed)

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
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <span>{requesterTitle(request.requester)}</span>
          <Badge
            variant="secondary"
            className={isPendingRequest
              ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
              : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'}
          >
            {request.status}
          </Badge>
        </p>
        {request.label && (
          <p className="mt-1.5 border-l-2 border-border pl-2 text-sm break-words">"{request.label}"</p>
        )}
        <div className="mt-1.5 text-sm text-muted-foreground">
          {groupRequestItems(request.items).map((group) => (
            <p key={group.environmentId} className="break-words">
              {/* One request can span projects: name the ones that are not this page's. */}
              {group.items[0]?.projectId !== projectId && `${group.projectName} / `}
              {group.environmentName}:{' '}
              {group.items.some((item) => item.secretName === '')
                ? 'all secrets'
                : <span className="mono-sm text-xs">{group.items.map((item) => item.secretName).join(', ')}</span>}
            </p>
          ))}
        </div>
        {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
      </div>
      <p className="text-xs text-muted-foreground sm:w-44 sm:shrink-0">
        {isPendingRequest
          ? <>Asked <TimeAgo ts={request.createdAt} /></>
          : request.expiry === 'never'
            ? <>Until revoked{request.approvedBy && <> · approved by {request.approvedBy}</>}</>
            : <>Last used <TimeAgo ts={request.lastUsedAt ?? request.createdAt} /></>}
      </p>
      {!isPendingRequest ? (
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          loading={isPending}
          onClick={() => run(() => revokeRequestAction({ requestId: request.id }))}
        >
          Revoke
        </Button>
      ) : canApproveAll ? (
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:items-center sm:gap-3">
          <Button
            className="w-full sm:w-auto"
            loading={isPending}
            onClick={() => run(async () => {
              if (!hasPasskey) throw new Error('Open Settings and ask an organization admin to trust your exact passkey before approving.')
              const assertion = await confirmWithPasskey({ kind: 'approve', requestId: request.id, itemIds, keep: false })
              await approveRequestAction({ requestId: request.id, itemIds, seenItemIds: itemIds, keep: false, assertion })
            })}
          >
            {hasPasskey ? 'Approve' : 'Trusted key required'}
          </Button>
          <Link href={reviewHref} className="text-center text-xs text-muted-foreground hover:text-foreground">
            Review details
          </Link>
        </div>
      ) : (
        <Button className="w-full sm:w-auto" render={<Link href={reviewHref} />}>
          Review
        </Button>
      )}
    </div>
  )
}
