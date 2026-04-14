// Sidebar styled after shadcn sidebar-07.
// Top: org switcher dropdown (like team-switcher)
// Middle: project list
// Bottom: user section with avatar, email, logout
//
// Uses plain tailwind + our dialog component instead of the full
// shadcn sidebar system (which is radix-dependent and very complex).

"use client";

import { useState, useRef, useEffect } from "react";
import { getRouter, Link } from "spiceflow/react";
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
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "sigillo-app/src/components/ui/dialog";
import type { App } from "../app.tsx";

type Org = { id: string; name: string; role: string };
type Project = { id: string; name: string };
type User = { name: string; email: string; image?: string | null } | null;

export function Sidebar({
  orgs,
  projects,
  currentOrgId,
  currentProjectId,
  user,
  createProjectAction,
}: {
  orgs: Org[];
  projects: Project[];
  currentOrgId: string | null;
  currentProjectId: string | null;
  user: User;
  createProjectAction: (prev: string, formData: FormData) => Promise<string>;
}) {
  const router = getRouter<App>();
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectMessage, setProjectMessage] = useState("");
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const orgRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  const currentOrg = orgs.find((o) => o.id === currentOrgId);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (orgRef.current && !orgRef.current.contains(e.target as Node)) {
        setOrgDropdownOpen(false);
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const userInitials = user?.name
    ? user.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()
    : "?";

  return (
    <aside className="flex flex-col w-72 border-r border-sidebar-border bg-background text-foreground p-6">
      {/* ── Org switcher (team-switcher style) ────────────────── */}
      <div ref={orgRef}>
        <button
          onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent cursor-pointer",
            orgDropdownOpen && "bg-sidebar-accent",
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
        </button>

        {orgDropdownOpen && (
          <div className="mt-1 rounded-lg border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Organizations
            </div>
            {orgs.map((org) => (
              <button
                key={org.id}
                onClick={() => {
                  setOrgDropdownOpen(false);
                  router.push(`/orgs/${org.id}`);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
              >
                <div className="flex size-6 items-center justify-center rounded-md border">
                  <BuildingIcon className="size-3.5 shrink-0" />
                </div>
                <span className="flex-1 text-left truncate">{org.name}</span>
                {org.id === currentOrgId && (
                  <CheckIcon className="size-3.5 text-muted-foreground" />
                )}
              </button>
            ))}
            <div className="my-1 h-px bg-border" />
            <button
              onClick={() => {
                setOrgDropdownOpen(false);
                router.push("/new-org");
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <PlusIcon className="size-4" />
              </div>
              <span className="text-muted-foreground font-medium">Add organization</span>
            </button>
          </div>
        )}
      </div>

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
                {isActive
                  ? <FolderOpenIcon className="size-4 shrink-0" />
                  : <FolderIcon className="size-4 shrink-0 opacity-60" />
                }
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
            <p className="text-xs text-muted-foreground px-2 py-1.5">Select an org first</p>
          )}
        </nav>
      </div>

      {/* ── User footer ──────────────────────────────────────── */}
      <div className="border-t border-sidebar-border pt-4" ref={userRef}>
        {userDropdownOpen && (
          <div className="mb-1 rounded-lg border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95">
            <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
                {user?.image ? (
                  <img src={user.image} alt="" className="size-8 rounded-lg object-cover" />
                ) : (
                  userInitials
                )}
              </div>
              <div className="grid flex-1 leading-tight min-w-0">
                <span className="truncate font-medium text-sm">{user?.name || "Guest"}</span>
                <span className="truncate text-xs text-muted-foreground">{user?.email || ""}</span>
              </div>
            </div>
            <div className="my-1 h-px bg-border" />
            <a
              href="/api/auth/sign-out"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent cursor-pointer"
            >
              <LogOutIcon className="size-4 text-muted-foreground" />
              Log out
            </a>
          </div>
        )}
        <button
          onClick={() => setUserDropdownOpen(!userDropdownOpen)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-sidebar-accent cursor-pointer",
            userDropdownOpen && "bg-sidebar-accent",
          )}
        >
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground font-medium text-xs">
            {user?.image ? (
              <img src={user.image} alt="" className="size-8 rounded-lg object-cover" />
            ) : (
              userInitials
            )}
          </div>
          <div className="grid flex-1 text-left leading-tight min-w-0">
            <span className="truncate font-medium text-sm">{user?.name || "Guest"}</span>
            <span className="truncate text-xs text-muted-foreground">{user?.email || ""}</span>
          </div>
          <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>

      {/* ── New project dialog ───────────────────────────────── */}
      <Dialog open={showNewProject} onOpenChange={setShowNewProject}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New Project</DialogTitle>
            <DialogDescription>
              Create a new project in this organization. It will get development, preview, and production environments by default.
            </DialogDescription>
          </DialogHeader>
          <form
            className="px-6 pb-2"
            action={async (formData: FormData) => {
              if (!currentOrgId) return;
              formData.set("orgId", currentOrgId);
              const result = await createProjectAction("", formData);
              if (result.startsWith("Created:")) {
                const projectId = result.split(":")[1];
                setShowNewProject(false);
                setProjectMessage("");
                router.push(`/orgs/${currentOrgId}/projects/${projectId}`);
              } else {
                setProjectMessage(result);
              }
            }}
          >
            <input
              name="name"
              placeholder="Project name"
              required
              autoFocus
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {projectMessage && (
              <p className="text-xs text-destructive mt-2">{projectMessage}</p>
            )}
            <DialogFooter variant="bare" className="mt-4">
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button type="submit">Create Project</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </aside>
  );
}
