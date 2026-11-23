// Settings page for the current project and its org.
// Contains project rename, approvals, passkeys, auto-join domain toggle, and a "Danger Zone"
// with project and org deletion. Each confirm dialog lists what will be
// deleted so the user knows exactly what they are losing.

'use client'

import { useState, useTransition } from 'react'
import { z } from 'zod'
import { parseFormData } from 'spiceflow'
import { AlertTriangleIcon, FolderIcon, UsersIcon } from 'lucide-react'
import { ErrorBoundary, useLoaderData } from 'spiceflow/react'
import { Button } from 'sigillo-app/src/components/ui/button'
import { Input } from 'sigillo-app/src/components/ui/input'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'sigillo-app/src/components/ui/dialog'
import { deleteOrgAction, deleteProjectAction, renameProjectAction, updateAutoJoinDomainAction } from '../actions.ts'
import { COMMON_EMAIL_DOMAINS, getEmailDomain } from '../lib/utils.ts'
import { ApprovalsSection, PasskeysSection, passkeyErrorMessage, withAccessPasskey } from 'sigillo-app/src/components/passkey'

const projectNameSchema = z.object({ name: z.string().trim().min(1, 'Name is required') })
const projectNameFields = projectNameSchema.keyof().enum

function ProjectNameSection() {
  const { projectId, projectName } = useLoaderData('/dash/projects/:projectId/*')

  return (
    <div className="rounded-lg border border-border">
      <div className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FolderIcon className="size-5" />
          Project name
        </h2>
        <p className="text-muted-foreground text-sm mt-2">
          The name shown in the sidebar and dashboard. The CLI uses the project ID, so renaming does not break existing setups.
        </p>
      </div>
      <ErrorBoundary
        below
        fallback={
          <div className="px-5 pb-4 flex items-center gap-3">
            <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
            <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer shrink-0">
              Dismiss
            </ErrorBoundary.ResetButton>
          </div>
        }
      >
        <form
          className="border-t border-border px-5 py-4 bg-muted/30 rounded-b-lg flex items-center gap-3"
          action={async (formData: FormData) => {
            const { name } = parseFormData(projectNameSchema, formData)
            if (name === projectName) return
            await renameProjectAction({ id: projectId, name })
          }}
        >
          <Input
            // Remount after a rename so the field shows the saved name
            key={projectName}
            aria-label="Project name"
            name={projectNameFields.name}
            defaultValue={projectName}
            required
            className="flex-1"
          />
          <Button type="submit">Save</Button>
        </form>
      </ErrorBoundary>
    </div>
  )
}

function DeleteProjectRow() {
  const { projectId, projectName, environments } = useLoaderData('/dash/projects/:projectId/*')
  const [open, setOpen] = useState(false)

  return (
    <div className="border-t border-destructive/40 px-5 py-4 bg-destructive/5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div>
        <p className="text-sm font-medium">Delete project</p>
        <p className="text-xs text-muted-foreground">
          Removes <span className="font-medium text-foreground">{projectName}</span>, its environments, secrets, and tokens.
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete project
        </Button>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Delete {projectName}?</DialogTitle>
            <DialogDescription>
              This will permanently delete the project, all its secrets and event history,
              and every API token scoped to it. Apps using those tokens stop working immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="px-6 pb-4">
            {environments.length > 0 ? (
              <div>
                <p className="text-sm font-medium mb-2">
                  The following {environments.length === 1 ? 'environment' : `${environments.length} environments`} will be deleted:
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  {environments.map((env) => (
                    <li key={env.id} className="flex items-center gap-2">
                      <span className="size-1.5 rounded-full bg-destructive shrink-0" />
                      {env.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                This project has no environments.
              </p>
            )}
          </div>
          <ErrorBoundary
            above
            fallback={
              <div className="px-6 pb-4 flex flex-col gap-2">
                <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
                <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer self-start">
                  Dismiss
                </ErrorBoundary.ResetButton>
              </div>
            }
          >
            <form
              action={async () => {
                await deleteProjectAction({ id: projectId })
              }}
            >
              <DialogFooter>
                <DialogClose render={<Button variant="outline" />}>
                  Cancel
                </DialogClose>
                <Button type="submit" variant="destructive">
                  Delete project
                </Button>
              </DialogFooter>
            </form>
          </ErrorBoundary>
        </DialogPopup>
      </Dialog>
    </div>
  )
}

function AutoJoinSection() {
  const { orgId, autoJoinDomain } = useLoaderData('/dash/projects/:projectId/settings')
  const { user } = useLoaderData('/dash/*')
  const [isPending, startTransition] = useTransition()
  const [currentDomain, setCurrentDomain] = useState(autoJoinDomain)
  const [error, setError] = useState<string | null>(null)

  const userDomain = getEmailDomain(user.email)
  const isPublicDomain = !userDomain || COMMON_EMAIL_DOMAINS.has(userDomain)

  // Hide the section entirely for users with public email domains
  // who also don't have auto-join already enabled (legacy data)
  if (isPublicDomain && !currentDomain) return null

  const isEnabled = !!currentDomain

  function handleToggle() {
    const newEnabled = !isEnabled
    setError(null)
    startTransition(async () => {
      try {
        const result = await withAccessPasskey({
          orgId,
          action: 'enable-auto-join',
          payload: JSON.stringify({ autoJoinDomain: userDomain }),
          run: (assertion) => updateAutoJoinDomainAction({ orgId, enabled: newEnabled, assertion }),
        })
        setCurrentDomain(result.autoJoinDomain)
      } catch (error) {
        setError(passkeyErrorMessage(error))
      }
    })
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <UsersIcon className="size-5" />
          Auto-join by email domain
        </h2>
        <p className="text-muted-foreground text-sm mt-2">
          {isEnabled ? (
            <>Users with a verified <span className="font-mono text-foreground">@{currentDomain}</span> email are automatically added to this organization.</>
          ) : (
            'Automatically add users to this organization based on their email domain.'
          )}
        </p>
      </div>
      <div className="border-t border-border px-5 py-4 bg-muted/30 rounded-b-lg flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">
            {isEnabled ? 'Auto-join is enabled' : 'Auto-join is disabled'}
          </p>
          {!isEnabled && userDomain && !isPublicDomain && (
            <p className="text-xs text-muted-foreground">
              Will use your email domain: <span className="font-mono">@{userDomain}</span>
            </p>
          )}
          {isPublicDomain && isEnabled && (
            <p className="text-xs text-muted-foreground">
              You can disable auto-join but cannot re-enable it with a public email domain.
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <Button
            variant={isEnabled ? 'outline' : 'default'}
            onClick={handleToggle}
            disabled={isPending || (!isEnabled && isPublicDomain)}
          >
            {isPending ? 'Saving...' : isEnabled ? 'Disable' : 'Enable'}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { orgId, orgName, projectNames } = useLoaderData('/dash/projects/:projectId/settings')
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleDelete() {
    startTransition(async () => {
      await deleteOrgAction({ orgId })
    })
  }

  return (
    <div className="flex flex-col gap-8 w-full max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage this project and its organization.
        </p>
      </div>

      <ProjectNameSection />

      <ApprovalsSection />

      <PasskeysSection />

      <AutoJoinSection />

      <div className="rounded-lg border border-destructive/40">
        <div className="p-5">
          <h2 className="text-lg font-semibold text-destructive flex items-center gap-2">
            <AlertTriangleIcon className="size-5" />
            Danger Zone
          </h2>
          <p className="text-muted-foreground text-sm mt-2">
            Deletions are permanent and take effect immediately. They cannot be undone.
          </p>
        </div>
        <DeleteProjectRow />
        <div className="border-t border-destructive/40 px-5 py-4 bg-destructive/5 rounded-b-lg flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div>
            <p className="text-sm font-medium">Delete organization</p>
            <p className="text-xs text-muted-foreground">
              Removes <span className="font-medium text-foreground">{orgName}</span>, all its projects, and member access.
            </p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <Button
              variant="destructive"
              onClick={() => setOpen(true)}
            >
              Delete organization
            </Button>
            <DialogPopup>
              <DialogHeader>
                <DialogTitle>Delete {orgName}?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the organization and everything inside it.
                </DialogDescription>
              </DialogHeader>
              <div className="px-6 pb-4">
                {projectNames.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium mb-2">
                      The following {projectNames.length === 1 ? 'project' : `${projectNames.length} projects`} will be deleted:
                    </p>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      {projectNames.map((name) => (
                        <li key={name} className="flex items-center gap-2">
                          <span className="size-1.5 rounded-full bg-destructive shrink-0" />
                          {name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    This organization has no projects.
                  </p>
                )}
              </div>
              <DialogFooter>
                <DialogClose
                  render={<Button variant="outline" />}
                >
                  Cancel
                </DialogClose>
                <Button
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={isPending}
                >
                  {isPending ? 'Deleting...' : 'Delete organization'}
                </Button>
              </DialogFooter>
            </DialogPopup>
          </Dialog>
        </div>
      </div>
    </div>
  )
}
