// Sidebar with org dropdown and project list.
// "New Organization" is an option in the dropdown → navigates to /new-org page.
// "New Project" button opens a dialog with a form.

"use client";

import { useState } from "react";
import { getRouter, Link } from "spiceflow/react";
import { PlusIcon, FolderIcon } from "lucide-react";
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

export function Sidebar({
  orgs,
  projects,
  currentOrgId,
  currentProjectId,
  createProjectAction,
}: {
  orgs: Org[];
  projects: Project[];
  currentOrgId: string | null;
  currentProjectId: string | null;
  createProjectAction: (prev: string, formData: FormData) => Promise<string>;
}) {
  const router = getRouter<App>();
  const [showNewProject, setShowNewProject] = useState(false);
  const [projectMessage, setProjectMessage] = useState("");

  return (
    <aside className="flex flex-col w-64 min-h-screen border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Org dropdown — includes "New Organization" as last option */}
      <div className="p-3 border-b border-sidebar-border">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5 block">
          Organization
        </label>
        <select
          className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          value={currentOrgId || "__new__"}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              router.push("/new-org");
            } else {
              router.push(`/?orgId=${e.target.value}`);
            }
          }}
        >
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))}
          <option value="__new__">+ New Organization…</option>
        </select>
      </div>

      {/* Project list */}
      <div className="flex-1 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Projects
          </span>
          {currentOrgId && (
            <button
              onClick={() => setShowNewProject(true)}
              className="text-muted-foreground hover:text-foreground cursor-pointer"
              title="New project"
            >
              <PlusIcon className="size-3.5" />
            </button>
          )}
        </div>

        <nav className="flex flex-col gap-0.5">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}?orgId=${currentOrgId}`}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                currentProjectId === project.id && "bg-sidebar-accent text-sidebar-accent-foreground font-medium",
              )}
            >
              <FolderIcon className="size-4 shrink-0 opacity-60" />
              {project.name}
            </Link>
          ))}
          {projects.length === 0 && currentOrgId && (
            <p className="text-xs text-muted-foreground px-2 py-1.5">No projects yet</p>
          )}
          {!currentOrgId && (
            <p className="text-xs text-muted-foreground px-2 py-1.5">Select an org first</p>
          )}
        </nav>
      </div>

      {/* New project dialog */}
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
                router.push(`/projects/${projectId}?orgId=${currentOrgId}`);
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
