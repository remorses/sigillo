// Tokens management page — table of API tokens with create/delete.
// Each token is scoped to a project and optionally to an env allowlist
// (zero rows = all envs). The full key is only shown once at creation
// (never stored), so the create dialog has a "copy key" step before closing.

"use client"

import { useState } from "react"
import { z } from "zod"
import { parseFormData } from "spiceflow"
import { useLoaderData } from "spiceflow/react"
import { ProjectTitle } from "sigillo-app/src/components/sidebar"
import { KeyIcon, TrashIcon, PlusIcon, CopyIcon, CheckIcon } from "lucide-react"
import { EmptyState } from "sigillo-app/src/components/ui/empty-state"
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
import { TimeAgo } from "sigillo-app/src/components/ui/time-ago"
import { cn } from "sigillo-app/src/lib/utils"
import { createTokenAction, deleteTokenAction } from "../actions.ts"


export function TokensPage() {
  const { projectId, environments, tokens } = useLoaderData('/dash/projects/:projectId/tokens')
  const [createOpen, setCreateOpen] = useState(false)

  return (
    <>
      <div className="flex items-center justify-between">
        <ProjectTitle />
        <Button variant="outline" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="size-4" />
          Create token
        </Button>
      </div>

      {tokens.length === 0 ? (
        <EmptyState
          icon={<KeyIcon className="size-6 text-muted-foreground" />}
          title="No API tokens yet"
          description="Create a token to access secrets programmatically via the API."
        >
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-4" />
            Create token
          </Button>
        </EmptyState>
      ) : (
        <TokensTable />
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

function tokenScopeLabel(environmentNames: string[]) {
  if (environmentNames.length === 0) return "All environments"
  return environmentNames.join(", ")
}

function TokensTable() {
  const { tokens } = useLoaderData('/dash/projects/:projectId/tokens')
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
                <code className="text-xs text-muted-foreground mono-sm">
                  sig_{token.prefix}••••
                </code>
              </TableCell>
              <TableCell>
                <span className="text-sm text-muted-foreground">
                  {tokenScopeLabel(token.environmentNames)}
                </span>
              </TableCell>
              <TableCell>
                <TimeAgo
                  ts={token.createdAt}
                  className="text-muted-foreground text-xs tabular-nums"
                />
              </TableCell>
              <TableCell className="p-0">
                <button
                  onClick={async () => {
                    if (confirm(`Delete token "${token.name}"? This cannot be undone.`)) {
                      try {
                        await deleteTokenAction({ tokenId: token.id })
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

const tokenSchema = z.object({ name: z.string().min(1, "Name is required") })
const tokenFields = tokenSchema.keyof().enum

function CreateTokenDialog({
  open,
  onOpenChange,
  projectId,
  environments,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  environments: { id: string; name: string; slug: string }[]
}) {
  const [creating, setCreating] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<"all" | "selected">("all")
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setCreatedKey(null)
      setCopied(false)
      setError(null)
      setScope("all")
      setChecked({})
    }
    onOpenChange(nextOpen)
  }

  async function handleCopy() {
    if (!createdKey) return
    await navigator.clipboard.writeText(createdKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // After key is created, show the "copy key" step.
  // Ignore close requests from backdrop click / Escape so the only visible
  // copy of the token is not lost accidentally. showCloseButton=false hides the X.
  if (createdKey) {
    return (
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) handleOpenChange(true)
        }}
      >
        <DialogPopup showCloseButton={false}>
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
                className="w-full mono-sm text-xs"
                onClick={(e) => e.currentTarget.select()}
              />
              <Button variant="outline" size="icon" onClick={handleCopy}>
                {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Store this key securely. It grants access to secrets in this project.
            </p>
            <DialogFooter variant="bare" className="mt-4">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
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
            const { name } = parseFormData(tokenSchema, formData)
            const environmentIds = scope === "all"
              ? []
              : environments.filter((env) => checked[env.id]).map((env) => env.id)
            if (scope === "selected" && environmentIds.length === 0) {
              setError("Select at least one environment")
              return
            }
            setCreating(true)
            setError(null)
            try {
              const result = await createTokenAction({
                name: name.trim(),
                projectId,
                environmentIds,
              })
              setCreatedKey(result.key)
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
                name={tokenFields.name}
                placeholder="e.g. CI/CD pipeline"
                required
                autoFocus
              />
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Environment scope</p>
              <div className="flex flex-col gap-1.5">
                <label className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                  scope === "all" ? "bg-primary/5" : "hover:bg-muted/50",
                )}>
                  <input
                    type="radio"
                    name="token-scope"
                    checked={scope === "all"}
                    onChange={() => setScope("all")}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium">All environments</span>
                </label>
                <label className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                  scope === "selected" ? "bg-primary/5" : "hover:bg-muted/50",
                )}>
                  <input
                    type="radio"
                    name="token-scope"
                    checked={scope === "selected"}
                    onChange={() => setScope("selected")}
                    className="accent-primary"
                  />
                  <span className="text-sm font-medium">Specific environments</span>
                </label>
              </div>
              {scope === "selected" && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {environments.map((env) => {
                    const isChecked = checked[env.id] ?? false
                    return (
                      <label
                        key={env.id}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                          isChecked ? "bg-primary/5" : "hover:bg-muted/50",
                        )}
                      >
                        <span
                          className={cn(
                            "flex items-center justify-center size-4 rounded border transition-colors",
                            isChecked ? "bg-primary border-primary text-primary-foreground" : "border-input",
                          )}
                          aria-hidden
                        >
                          {isChecked && <CheckIcon className="size-3" />}
                        </span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => setChecked((prev) => ({ ...prev, [env.id]: !prev[env.id] }))}
                          className="sr-only"
                        />
                        <span className="text-sm font-medium">{env.name}</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={creating}>
              Create token
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
