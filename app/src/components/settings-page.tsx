// Settings page for org-level configuration.
// Currently contains a "Danger Zone" section with org deletion.
// The confirm dialog shows the list of projects that will be deleted
// so the user knows exactly what they are losing.

'use client'

import { useState, useTransition } from 'react'
import { AlertTriangleIcon } from 'lucide-react'
import { useLoaderData } from 'spiceflow/react'
import { Button } from 'sigillo-app/src/components/ui/button'
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from 'sigillo-app/src/components/ui/dialog'
import { deleteOrgAction } from '../actions.ts'

export function SettingsPage() {
  const { orgId, orgName, projectNames } = useLoaderData('/orgs/:orgId/projects/:projectId/settings')
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
          Manage your organization settings.
        </p>
      </div>

      <div className="rounded-lg border border-destructive/40">
        <div className="p-5">
          <h2 className="text-lg font-semibold text-destructive flex items-center gap-2">
            <AlertTriangleIcon className="size-5" />
            Danger Zone
          </h2>
          <p className="text-muted-foreground text-sm mt-2">
            Deleting this organization is permanent. All projects, environments,
            secrets, tokens, and member access will be removed immediately.
          </p>
        </div>
        <div className="border-t border-destructive/40 px-5 py-4 bg-destructive/5 rounded-b-lg flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Delete organization</p>
            <p className="text-xs text-muted-foreground">
              This action cannot be undone.
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
