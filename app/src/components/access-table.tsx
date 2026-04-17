// Access table for organization members.
// Admins can change roles inline and remove members from the org.

"use client"

import { useState } from "react"
import { TrashIcon } from "lucide-react"
import { removeOrgMemberAction, updateOrgMemberRoleAction } from "sigillo-app/src/actions"
import { Button } from "sigillo-app/src/components/ui/button"
import { Frame } from "sigillo-app/src/components/ui/frame"
import { NativeSelect } from "sigillo-app/src/components/ui/native-select"
import { Spinner } from "sigillo-app/src/components/ui/spinner"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "sigillo-app/src/components/ui/table"
import { formatTime } from "sigillo-app/src/lib/utils"

type Member = {
  id: string
  createdAt: number
  role: "admin" | "member"
  user: {
    id: string
    email: string | null
    image: string | null
    name: string | null
  } | null
}

export function AccessTable({
  currentUserId,
  canManage,
  members,
}: {
  currentUserId: string
  canManage: boolean
  members: Member[]
}) {
  const [roleOverrides, setRoleOverrides] = useState<Record<string, Member["role"]>>({})
  const [pendingRoleId, setPendingRoleId] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function getRole(member: Member) {
    return roleOverrides[member.id] ?? member.role
  }

  const adminCount = members.reduce((count, member) => {
    return count + (getRole(member) === "admin" ? 1 : 0)
  }, 0)

  function saveRole(member: Member, nextRole: Member["role"]) {
    const previousRole = getRole(member)
    setError(null)
    setRoleOverrides((current) => ({ ...current, [member.id]: nextRole }))
    setPendingRoleId(member.id)
    void (async () => {
      try {
        await updateOrgMemberRoleAction({ memberId: member.id, role: nextRole })
      } catch (error) {
        setRoleOverrides((current) => ({ ...current, [member.id]: previousRole }))
        setError(error instanceof Error ? error.message : "Failed to update role")
      } finally {
        setPendingRoleId((current) => (current === member.id ? null : current))
      }
    })
  }

  function removeMember(member: Member) {
    const name = member.user?.name || member.user?.email || "this user"
    if (!confirm(`Remove ${name} from this organization?`)) {
      return
    }

    setError(null)
    setPendingDeleteId(member.id)
    void (async () => {
      try {
        await removeOrgMemberAction({ memberId: member.id })
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to remove user")
      } finally {
        setPendingDeleteId((current) => (current === member.id ? null : current))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Frame className="w-full">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-1/4" />
            <col className="w-1/3" />
            <col className="w-36" />
            <col className="w-32" />
            {canManage ? <col className="w-16" /> : null}
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {canManage ? <TableHead /> : null}
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
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {member.user?.image ? (
                        <img src={member.user.image} alt="" className="size-6 rounded-full object-cover" />
                      ) : (
                        <div className="size-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
                          {(member.user?.name || member.user?.email || "?").charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-sm font-medium">{member.user?.name || "—"}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">{member.user?.email || "—"}</span>
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <div className="relative w-full">
                        <NativeSelect
                          disabled={isBusy}
                          value={currentRole}
                          onChange={(event) => {
                            const nextRole = event.target.value as Member["role"]
                            if (nextRole === currentRole) {
                              return
                            }
                            saveRole(member, nextRole)
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
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatTime(member.createdAt)}
                    </span>
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
                        onClick={() => removeMember(member)}
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
    </div>
  )
}
