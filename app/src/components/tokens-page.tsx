// Tokens management page — table of API tokens with create/delete.
// Each token is scoped to a project and optionally to a single environment.
// The full key is only shown once at creation (never stored), so the
// create dialog has a "copy key" step before closing.

"use client"

import { useState } from "react"
import { getRouter, ErrorBoundary } from "spiceflow/react"
import { KeyIcon, TrashIcon, PlusIcon, CopyIcon, CheckIcon } from "lucide-react"
import { Button } from "sigillo-app/src/components/ui/button"
import { Frame } from "sigillo-app/src/components/ui/frame"
import { Input } from "sigillo-app/src/components/ui/input"
import {
  Dialog, DialogPopup, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter, DialogClose,
} from "sigillo-app/src/components/ui/dialog"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "sigillo-app/src/components/ui/table"
import { formatTime } from "sigillo-app/src/lib/utils"
import { createTokenAction, deleteTokenAction } from "../actions.ts"
import type { App } from "../app.tsx"

type Token = {
  id: string
  name: string
  prefix: string
  environmentId: string | null
  environmentName: string | null
  createdBy: string
  createdAt: number
}

type Environment = { id: string; name: string; slug: string }

export function TokensPage({
  projectName,
  projectId,
  orgId,
  environments,
  tokens,
}: {
  projectName: string
  projectId: string
  orgId: string
  environments: Environment[]
  tokens: Token[]
}) {
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
        <Button variant="outline" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          Create token
        </Button>
      </div>

      {tokens.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted mb-4">
            <KeyIcon className="size-6 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold mb-1">No API tokens yet</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Create a token to access secrets programmatically via the API.
          </p>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            Create token
          </Button>
        </div>
      ) : (
        <TokensTable tokens={tokens} projectId={projectId} />
      )}

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        environments={environments}
      />
    </>
  )
}

function TokensTable({ tokens, projectId }: { tokens: Token[]; projectId: string }) {
  const router = getRouter<App>()

  return (
    <Frame className="w-full">
      <Table className="table-fixed">
        <colgroup>
          <col className="w-1/4" />
          <col className="w-1/4" />
          <col className="w-1/5" />
          <col className="w-32" />
          <col className="w-16" />
        </colgroup>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Created</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id}>
              <TableCell>
                <span className="text-sm font-medium">{token.name}</span>
              </TableCell>
              <TableCell>
                <code className="text-xs text-muted-foreground font-mono">
                  sig_{token.prefix}••••
                </code>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {token.environmentName ?? "All environments"}
                </span>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatTime(token.createdAt)}
                </span>
              </TableCell>
              <TableCell className="p-0">
                <button
                  onClick={async () => {
                    if (confirm(`Delete token "${token.name}"? This cannot be undone.`)) {
                      try {
                        await deleteTokenAction({ tokenId: token.id })
                        router.refresh()
                      } catch (e: any) {
                        alert(e?.message || "Failed to delete token")
                      }
                    }
                  }}
                  className="text-muted-foreground hover:text-destructive cursor-pointer"
                  title="Delete token"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Frame>
  )
}

function CreateTokenDialog({
  open,
  onOpenChange,
  projectId,
  environments,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  environments: Environment[]
}) {
  const router = getRouter<App>()
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleOpenChange(open: boolean) {
    if (!open) {
      // Reset state when closing
      setCreatedKey(null)
      setCopied(false)
      setError(null)
    }
    onOpenChange(open)
  }

  async function handleCopy() {
    if (!createdKey) return
    await navigator.clipboard.writeText(createdKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // After key is created, show the "copy key" step
  if (createdKey) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription>
              Copy this token now — you won't be able to see it again.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-2">
            <div className="flex gap-2">
              <Input
                readOnly
                value={createdKey}
                className="w-full font-mono text-xs"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <Button variant="outline" size="icon" onClick={handleCopy}>
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Store this key securely. It grants access to secrets in this project.
            </p>
            <DialogFooter variant="bare" className="mt-4">
              <DialogClose render={<Button variant="outline" />}>
                Done
              </DialogClose>
            </DialogFooter>
          </div>
        </DialogPopup>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Create API token</DialogTitle>
          <DialogDescription>
            Generate a token for programmatic access to secrets in this project.
          </DialogDescription>
        </DialogHeader>
        <form
          className="px-6 pb-2"
          action={async (formData: FormData) => {
            const name = formData.get("name") as string
            const environmentId = formData.get("environmentId") as string
            if (!name?.trim()) return
            setCreating(true)
            setError(null)
            try {
              const result = await createTokenAction({
                name: name.trim(),
                projectId,
                environmentId: environmentId || null,
              })
              setCreatedKey(result.key)
              router.refresh()
            } catch (e: any) {
              setError(e?.message || "Failed to create token")
            } finally {
              setCreating(false)
            }
          }}
        >
          {error && (
            <p className="text-sm text-destructive mb-3">{error}</p>
          )}
          <div className="flex flex-col gap-3">
            <div>
              <label htmlFor="token-name" className="text-sm font-medium mb-1 block">Name</label>
              <Input
                id="token-name"
                name="name"
                placeholder="e.g. CI/CD pipeline"
                required
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="token-env" className="text-sm font-medium mb-1 block">Environment scope</label>
              <select
                id="token-env"
                name="environmentId"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">All environments</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>{env.name}</option>
                ))}
              </select>
            </div>
          </div>
          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" loading={creating}>
              Create token
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
