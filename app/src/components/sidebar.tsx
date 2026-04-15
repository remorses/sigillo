// Sidebar styled after shadcn sidebar-07.
// Top: org switcher dropdown (like team-switcher)
// Middle: project list
// Bottom: user section with avatar, email, logout
//
// Dropdowns use @base-ui/react Menu (portal-based) to avoid layout shifts.
// The old implementation rendered dropdowns inline which pushed content around.

"use client";

import { useState } from "react";
import { getRouter, Link, ErrorBoundary } from "spiceflow/react";
import {
  PlusIcon,
  FolderIcon,
  FolderOpenIcon,
  ChevronsUpDownIcon,
  BuildingIcon,
  LogOutIcon,
  CheckIcon,
} from "lucide-react";
import { cn } from "sigillo-app/src/lib/utils";
import { Button } from "sigillo-app/src/components/ui/button";
import { Input } from "sigillo-app/src/components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "sigillo-app/src/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuPopup,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "sigillo-app/src/components/ui/dropdown-menu";
import { createProjectAction } from "../actions.ts";
import type { App } from "../app.tsx";

export function Sidebar({
  orgs,
  projects,
  currentOrgId,
  currentProjectId,
  user,
}: {
  orgs: { id: string; name: string; role: string }[];
  projects: { id: string; name: string }[];
  currentOrgId: string | null;
  currentProjectId: string | null;
  user: { name: string; email: string; image?: string | null } | null;
}) {
  const router = getRouter<App>();
  const [showNewProject, setShowNewProject] = useState(false);

  const currentOrg = orgs.find((o) => o.id === currentOrgId);

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <aside className="flex flex-col w-72 self-stretch min-h-0 border-r border-sidebar-border bg-background text-foreground p-6">
      {/* ── Org switcher ─────────────────────────────────────── */}
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground text-background">
            <BuildingIcon className="size-4" />
          </div>
          <div className="grid flex-1 text-left leading-tight min-w-0">
            <span className="truncate font-medium text-sm">
              {currentOrg?.name || "Select org"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {currentOrg?.role || "No organization"}
            </span>
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuPopup side="bottom" align="start" sideOffset={4}>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuLinkItem
              key={org.id}
              href={`/orgs/${org.id}`}
            >
              <div className="flex size-6 items-center justify-center rounded-md border">
                <BuildingIcon className="size-3.5 shrink-0" />
              </div>
              <span className="flex-1 truncate">{org.name}</span>
              {org.id === currentOrgId && (
                <CheckIcon className="size-3.5 text-muted-foreground" />
              )}
            </DropdownMenuLinkItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLinkItem href="/new-org">
            <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <PlusIcon className="size-4" />
            </div>
            <span className="text-muted-foreground font-medium">
              Add organization
            </span>
          </DropdownMenuLinkItem>
        </DropdownMenuPopup>
      </DropdownMenu>

      {/* ── Projects ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto pt-4">
        <div className="mb-1 pl-2">
          <span className="text-xs font-medium text-muted-foreground">
            Projects
          </span>
        </div>

        <nav className="flex flex-col gap-0.5">
          {projects.map((project) => {
            const isActive = currentProjectId === project.id;
            return (
              <Link
                key={project.id}
                href={`/orgs/${currentOrgId}/projects/${project.id}`}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                  isActive && "bg-sidebar-accent text-foreground font-medium",
                )}
              >
                {isActive ? (
                  <FolderOpenIcon className="size-4 shrink-0" />
                ) : (
                  <FolderIcon className="size-4 shrink-0 opacity-60" />
                )}
                {project.name}
              </Link>
            );
          })}
          {currentOrgId && (
            <button
              onClick={() => setShowNewProject(true)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground cursor-pointer"
            >
              <PlusIcon className="size-4 shrink-0 opacity-60" />
              New project
            </button>
          )}
          {!currentOrgId && (
            <p className="text-xs text-muted-foreground px-2 py-1.5">
              Select an org first
            </p>
          )}
        </nav>
      </div>

      {/* ── User footer ──────────────────────────────────────── */}
      <div className="border-t border-sidebar-border pt-4">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent data-[popup-open]:bg-sidebar-accent",
            )}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
              {user?.image ? (
                <img
                  src={user.image}
                  alt=""
                  className="size-8 rounded-lg object-cover"
                />
              ) : (
                userInitials
              )}
            </div>
            <div className="grid flex-1 text-left leading-tight min-w-0">
              <span className="truncate font-medium text-sm">
                {user?.name || "Guest"}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {user?.email || ""}
              </span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>

          <DropdownMenuPopup side="top" align="start" sideOffset={4}>
            {/* User info header */}
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
                {user?.image ? (
                  <img
                    src={user.image}
                    alt=""
                    className="size-8 rounded-lg object-cover"
                  />
                ) : (
                  userInitials
                )}
              </div>
              <div className="grid flex-1 leading-tight min-w-0">
                <span className="truncate font-medium text-sm">
                  {user?.name || "Guest"}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user?.email || ""}
                </span>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuLinkItem href="/api/auth/sign-out">
              <LogOutIcon className="size-4 text-muted-foreground" />
              Log out
            </DropdownMenuLinkItem>
          </DropdownMenuPopup>
        </DropdownMenu>
      </div>

      {/* ── New project dialog ───────────────────────────────── */}
      <NewProjectDialog
        open={showNewProject}
        onOpenChange={setShowNewProject}
        orgId={currentOrgId}
      />
    </aside>
  );
}

// ── Shared new project dialog ──────────────────────────────────
// Used by both the Sidebar and the empty-state NewProjectButton.

export function NewProjectDialog({
  open,
  onOpenChange,
  orgId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string | null;
}) {
  const router = getRouter<App>();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Create a new project in this organization. It will get development,
            preview, and production environments by default.
          </DialogDescription>
        </DialogHeader>
        <ErrorBoundary
          fallback={
            <div className="px-6 pb-4 flex flex-col gap-2">
              <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
              <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer self-start">
                Try again
              </ErrorBoundary.ResetButton>
            </div>
          }
        >
          <form
            className="px-6 pb-2"
            action={async (formData: FormData) => {
              if (!orgId) return;
              const name = formData.get("name") as string;
              const result = await createProjectAction({ name, orgId });
              onOpenChange(false);
              router.push(`/orgs/${orgId}/projects/${result.id}`);
            }}
          >
            <Input
              name="name"
              placeholder="Project name"
              required
              autoFocus
              className="w-full"
            />
            <DialogFooter variant="bare" className="mt-4">
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button type="submit">Create Project</Button>
            </DialogFooter>
          </form>
        </ErrorBoundary>
      </DialogPopup>
    </Dialog>
  );
}

// ── Standalone create-project button + dialog ──────────────────
// Used in the empty state page when an org has no projects yet.

export function NewProjectButton({
  orgId,
}: {
  orgId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <PlusIcon className="size-4 mr-2" />
        Create project
      </Button>
      <NewProjectDialog
        open={open}
        onOpenChange={setOpen}
        orgId={orgId}
      />
    </>
  );
}
