// Access table for organization members.
// Admins can change roles inline, remove members, and manage per-project access.

"use client"

import { useState } from "react"
import { TrashIcon, PencilIcon } from "lucide-react"
import { removeOrgMemberAction, updateOrgMemberRoleAction, updateMemberAccessAction } from "sigillo-app/src/actions"
import { InviteButton } from "sigillo-app/src/components/invite-dialog"
import { Button } from "sigillo-app/src/components/ui/button"
import { Frame } from "sigillo-app/src/components/ui/frame"
import { NativeSelect } from "sigillo-app/src/components/ui/native-select"
import { Spinner } from "sigillo-app/src/components/ui/spinner"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogClose } from "sigillo-app/src/components/ui/dialog"
import { useLoaderData } from "spiceflow/react"
import { ProjectTitle } from "sigillo-app/src/components/sidebar"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "sigillo-app/src/components/ui/table"
import { TimeAgo } from "sigillo-app/src/components/ui/time-ago"

type Member = {
  id: string
  createdAt: number
  role: "admin" | "member"
  projectAccess: "all" | "selected"
  accessRules: { projectId: string }[]
  user: {
    id: string
    email: string | null
    image: string | null
    name: string | null
  } | null
}

export function AccessPage() {
  const { orgId, role } = useLoaderData('/dash/projects/:projectId/access')

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between">
        <ProjectTitle />
        {role === 'admin' ? <InviteButton orgId={orgId} /> : null}
      </div>
      <AccessTable />
    </div>
  )
}

export function AccessTable() {
  const { role, currentUserId, members, orgProjects } = useLoaderData('/dash/projects/:projectId/access')
  const canManage = role === 'admin'
  const [roleOverrides, setRoleOverrides] = useState<Record<string, Member["role"]>>({})
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null)

  function getRole(member: Member) {
    return roleOverrides[member.id] ?? member.role
  }

  const adminCount = members.reduce((count, member) => {
    return count + (getRole(member) === "admin" ? 1 : 0)
  }, 0)

  async function saveRole(member: Member, nextRole: Member["role"]) {
    const previousRole = getRole(member)
    setError(null)
    setRoleOverrides((current) => ({ ...current, [member.id]: nextRole }))
    setPendingRoleId(member.id)
    try {
      await updateOrgMemberRoleAction({ memberId: member.id, role: nextRole })
    } catch (error) {
      setRoleOverrides((current) => ({ ...current, [member.id]: previousRole }))
      setError(error instanceof Error ? error.message : "Failed to update role")
    } finally {
      setPendingRoleId((current) => (current === member.id ? null : current))
    }
  }

  async function removeMember(member: Member) {
    const name = member.user?.name || member.user?.email || "this user"
    if (!confirm(`Remove ${name} from this organization?`)) {
      return
    }

    setError(null)
    setPendingDeleteId(member.id)
    try {
      await removeOrgMemberAction({ memberId: member.id })
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to remove user")
    } finally {
      setPendingDeleteId((current) => (current === member.id ? null : current))
    }
  }

  function getProjectAccessLabel(member: Member) {
    if (getRole(member) === 'admin') return 'All (admin)'
    if (member.projectAccess === 'all') return 'All'
    return `${member.accessRules.length} of ${orgProjects.length}`
  }

  const editingMember = editingMemberId ? members.find((m) => m.id === editingMemberId) ?? null : null

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Frame className="w-full overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="min-w-[180px]">Member</TableHead>
              <TableHead className="w-28">Role</TableHead>
              <TableHead className="w-28">Projects</TableHead>
              <TableHead className="w-28">Joined</TableHead>
              {canManage ? <TableHead className="w-12" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const currentRole = getRole(member)
              const isSavingRole = pendingRoleId === member.id
              const isDeleting = pendingDeleteId === member.id
              const isBusy = isSavingRole || isDeleting
              const isCurrentUser = member.user?.id === currentUserId
              const isLastAdmin = currentRole === "admin" && adminCount === 1
              return (
                <TableRow key={member.id}>
                  <TableCell className="max-w-[260px]">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {member.user?.image ? (
                        <img src={member.user.image} alt="" className="size-7 shrink-0 rounded-full object-cover" />
                      ) : (
                        <div className="size-7 shrink-0 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {(member.user?.name || member.user?.email || "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="flex flex-col min-w-0 overflow-hidden">
                        <span className="text-sm font-medium truncate">{member.user?.name || "—"}</span>
                        <span className="text-xs text-muted-foreground truncate">{member.user?.email || "—"}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <div className="relative">
                        <NativeSelect
                          disabled={isBusy}
                          value={currentRole}
                          onChange={(event) => {
                            const nextRole: Member['role'] = event.currentTarget.value === 'admin' ? 'admin' : 'member'
                            if (nextRole === currentRole) {
                              return
                            }
                            void saveRole(member, nextRole)
                          }}
                        >
                          <option value="admin">Admin</option>
                          <option disabled={isLastAdmin} value="member">Member</option>
                        </NativeSelect>
                        {isSavingRole ? (
                          <Spinner className="absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-xs font-medium capitalize">{member.role}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 whitespace-nowrap"
                      disabled={currentRole === 'admin' || !canManage}
                      onClick={() => canManage && currentRole !== 'admin' ? setEditingMemberId(member.id) : undefined}
                    >
                      {getProjectAccessLabel(member)}
                      {canManage && currentRole !== 'admin' && <PencilIcon className="size-3 opacity-50" />}
                    </button>
                  </TableCell>
                  <TableCell>
                    <TimeAgo
                      ts={member.createdAt}
                      className="text-muted-foreground text-xs tabular-nums whitespace-nowrap"
                    />
                  </TableCell>
                  {canManage ? (
                    <TableCell className="p-0">
                      <Button
                        aria-label={isCurrentUser ? "Remove yourself" : "Remove user"}
                        disabled={isBusy || isLastAdmin}
                        loading={isDeleting}
                        size="icon-xs"
                        title={isLastAdmin
                          ? "This organization needs at least one admin"
                          : isCurrentUser
                            ? "Remove yourself"
                            : "Remove user"}
                        variant="ghost"
                        onClick={() => { void removeMember(member) }}
                      >
                        <TrashIcon className="size-3.5 text-muted-foreground" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </Frame>

      {/* Keyed + mounted per member: dialog state is initialized from the
          member, so a shared instance kept "Full access" from a null member. */}
      {editingMember && (
        <ManageAccessDialog
          key={editingMember.id}
          member={editingMember}
          orgProjects={orgProjects}
          open
          onClose={() => setEditingMemberId(null)}
        />
      )}
    </div>
  )
}

// ── Manage Access Dialog ──────────────────────────────────────────────
// Admins use this to configure per-project access and secret restrictions
// for a specific member.

function ManageAccessDialog({
  member,
  orgProjects,
  open,
  onClose,
}: {
  member: Member | null
  orgProjects: { id: string; name: string }[]
  open: boolean
  onClose: () => void
}) {
  const existingRuleIds = new Set((member?.accessRules ?? []).map((r) => r.projectId))
  const hasExistingRules = member?.projectAccess === 'selected'

  // State: which projects are checked
  const [fullAccess, setFullAccess] = useState(!hasExistingRules)
  const [projectChecked, setProjectChecked] = useState<Record<string, boolean>>(() => {
    if (!hasExistingRules) {
      return Object.fromEntries(orgProjects.map((p) => [p.id, true]))
    }
    return Object.fromEntries(orgProjects.map((p) => [p.id, existingRuleIds.has(p.id)]))
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    if (!member) return
    setSaving(true)
    setError(null)
    try {
      if (fullAccess) {
        await updateMemberAccessAction({ memberId: member.id, projectIds: null })
      } else {
        const selectedIds = orgProjects.filter((p) => projectChecked[p.id]).map((p) => p.id)
        await updateMemberAccessAction({ memberId: member.id, projectIds: selectedIds })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Manage Access for {member?.user?.name || member?.user?.email || 'Member'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-6 py-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={fullAccess}
              onChange={(e) => {
                setFullAccess(e.target.checked)
                if (e.target.checked) {
                  setProjectChecked(Object.fromEntries(orgProjects.map((p) => [p.id, true])))
                }
              }}
              className="accent-primary"
            />
            <span className="font-medium">Full access to all projects</span>
          </label>

          {!fullAccess && (
            <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
              {orgProjects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm p-2 rounded border border-border">
                  <input
                    type="checkbox"
                    checked={!!projectChecked[project.id]}
                    onChange={(e) => setProjectChecked((prev) => ({ ...prev, [project.id]: e.target.checked }))}
                    className="accent-primary"
                  />
                  <span className="font-medium">{project.name}</span>
                </label>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button onClick={handleSave} loading={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
