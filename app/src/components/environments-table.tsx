// Environments table for a project (standalone tab).
// Shows name, slug, description, timestamps. Supports inline rename,
// description editing in a dialog, delete, and add.
// All environments are user-managed — no hardcoded "default" protection.

"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { NotebookPenIcon, PencilIcon, TrashIcon } from "lucide-react";
import { useState, useRef } from "react";
import { z } from "zod";
import { parseFormData } from "spiceflow";
import { ErrorBoundary, useLoaderData } from "spiceflow/react";
import { ProjectTitle } from "sigillo-app/src/components/sidebar";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { cn, ENV_DESCRIPTION_MAX_LENGTH } from "sigillo-app/src/lib/utils";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input, Textarea } from "sigillo-app/src/components/ui/input";
import {
  Dialog, DialogPopup, DialogHeader, DialogTitle,
  DialogDescription, DialogClose, DialogFooter,
} from "sigillo-app/src/components/ui/dialog";
import { TimeAgo } from "sigillo-app/src/components/ui/time-ago";
import { createEnvAction, deleteEnvAction, updateEnvAction, updateEnvironmentAccessRoleAction } from "../actions.ts";
import { NativeSelect } from "sigillo-app/src/components/ui/native-select";
import { passkeyErrorMessage, withAccessPasskey } from "sigillo-app/src/components/passkey";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "sigillo-app/src/components/ui/table";

type Environment = {
  id: string;
  name: string;
  slug: string;
  description: string;
  accessRole: string;
  createdAt: number;
  updatedAt: number;
};

const knownEnvColors: Record<string, string> = {
  development: "bg-primary",
  dev: "bg-primary",
  preview: "bg-amber-500",
  staging: "bg-amber-500",
  production: "bg-emerald-500",
  prod: "bg-emerald-500",
};

// Deterministic color palette for custom env names not in the known list.
const envColorPalette = [
  "bg-violet-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-rose-500",
  "bg-teal-500",
  "bg-indigo-500",
  "bg-lime-500",
];

export function getEnvColor(name: string, slug: string): string {
  const key = slug.toLowerCase();
  const nameKey = name.toLowerCase();
  if (knownEnvColors[key]) return knownEnvColors[key]!;
  if (knownEnvColors[nameKey]) return knownEnvColors[nameKey]!;
  // Deterministic hash of slug for consistent color across renders.
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return envColorPalette[hash % envColorPalette.length]!;
}

// Inline editable name+slug cell for a single environment row.
function EditableEnvCell({ env, field }: { env: Environment; field: "name" | "slug" }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(env[field]);
  const inputRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === env[field]) {
      setValue(env[field]);
      setEditing(false);
      return;
    }
    try {
      await updateEnvAction({ id: env.id, [field]: trimmed });
      setEditing(false);
    } catch (e: any) {
      alert(e?.message || `Failed to rename ${field}`);
      setValue(env[field]);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <form
        className="flex items-center gap-1"
        onSubmit={async (e) => {
          e.preventDefault();
          await save();
        }}
      >
        <Input
          ref={inputRef}
          inputSize="sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          autoFocus
          className={cn("h-7 w-full", field === "slug" && "mono-sm")}
        />
      </form>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 cursor-pointer text-left"
      title={`Click to edit ${field}`}
    >
      {field === "name" ? (
        <span className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", getEnvColor(env.name, env.slug))} />
          {env.name}
        </span>
      ) : (
        <Badge variant="outline" size="default">
          <span className="mono-sm">{env.slug}</span>
        </Badge>
      )}
      <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

// Description cell: shows the text (truncated) and opens a dialog to view
// the full text and edit it.
function EnvDescriptionCell({ env }: { env: Environment }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(env.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setValue(env.description);
      setError(null);
    }
    setOpen(next);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await updateEnvAction({ id: env.id, description: value });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save description");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={() => handleOpenChange(true)}
        className="group flex w-full min-w-0 items-center gap-1.5 cursor-pointer text-left"
        title={env.description || "Add description"}
      >
        {env.description ? (
          <span className="truncate">{env.description}</span>
        ) : (
          <span className="truncate text-muted-foreground">Add description</span>
        )}
        <NotebookPenIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{env.name} description</DialogTitle>
            <DialogDescription>
              Explain what this environment is for. Shown here and in <code className="mono-sm">sigillo environments</code>.
            </DialogDescription>
          </DialogHeader>
          <form
            className="px-6 pb-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await handleSave();
            }}
          >
            {error && <p className="text-sm text-destructive mb-3">{error}</p>}
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. Production deploys on Cloudflare. Only admins can read secrets."
              rows={5}
              maxLength={ENV_DESCRIPTION_MAX_LENGTH}
              autoFocus
            />
            <DialogFooter variant="bare" className="mt-4 px-0">
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button type="submit" loading={saving}>Save</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

const envSchema = z.object({ name: z.string().min(1, "Name is required"), slug: z.string().min(1, "Slug is required") });
const envFields = envSchema.keyof().enum;

export function EnvironmentsPage() {

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between">
        <ProjectTitle />
      </div>
      <EnvironmentsTable />
    </div>
  );
}

export function EnvironmentsTable() {
  const { environments, projectId, orgId } = useLoaderData('/dash/projects/:projectId/environments');
  const [showNewRow, setShowNewRow] = useState(false);

  const columns: ColumnDef<Environment>[] = [
    {
      accessorKey: "name",
      header: "Environment",
      size: 200,
      cell: ({ row }) => <EditableEnvCell env={row.original} field="name" />,
    },
    {
      accessorKey: "slug",
      header: "Slug",
      size: 160,
      cell: ({ row }) => <EditableEnvCell env={row.original} field="slug" />,
    },
    {
      accessorKey: "description",
      header: "Description",
      size: 260,
      cell: ({ row }) => <EnvDescriptionCell env={row.original} />,
    },
    {
      accessorKey: "accessRole",
      header: "Min Role",
      size: 120,
      cell: ({ row }) => (
        <NativeSelect
          value={row.original.accessRole}
          onChange={async (e) => {
            const nextRole: 'admin' | 'member' = e.currentTarget.value === 'admin' ? 'admin' : 'member'
            if (nextRole === row.original.accessRole) return
            const environmentId = row.original.id
            try {
              await withAccessPasskey({
                orgId,
                action: 'set-environment-access-role',
                payload: JSON.stringify({ environmentId, accessRole: nextRole }),
                run: (assertion) => updateEnvironmentAccessRoleAction({ environmentId, accessRole: nextRole, assertion }),
              })
            } catch (err) {
              alert(passkeyErrorMessage(err))
            }
          }}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </NativeSelect>
      ),
    },
    {
      accessorKey: "updatedAt",
      header: "Last Updated",
      size: 130,
      cell: ({ row }) => (
        <TimeAgo
          ts={row.original.updatedAt}
          className="text-muted-foreground text-xs tabular-nums"
        />
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 130,
      cell: ({ row }) => (
        <TimeAgo
          ts={row.original.createdAt}
          className="text-muted-foreground text-xs tabular-nums"
        />
      ),
    },
    {
      id: "actions",
      size: 50,
      cell: ({ row }) => (
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (confirm(`Delete environment "${row.original.name}"? All secrets in this environment will be lost.`)) {
              try {
                await deleteEnvAction({ id: row.original.id });
              } catch (e: any) {
                alert(e?.message || "Failed to delete environment");
              }
            }
          }}
          className="text-muted-foreground hover:text-destructive cursor-pointer"
          title="Delete environment"
        >
          <TrashIcon className="size-3.5" />
        </button>
      ),
    },
  ];

  const table = useReactTable({
    columns,
    data: environments,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Frame className="w-full">
      <Table className="table-fixed">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow className="hover:bg-transparent" key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const columnSize = header.column.getSize();
                return (
                  <TableHead
                    key={header.id}
                    style={columnSize ? { width: `${columnSize}px` } : undefined}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-balance text-muted-foreground py-8">
                No environments yet. Add one below.
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="p-2 border-t border-border">
        {showNewRow ? (
          <ErrorBoundary
            fallback={
              <div className="flex items-center gap-2 px-2 py-1">
                <ErrorBoundary.ErrorMessage className="text-xs text-destructive" />
                <ErrorBoundary.ResetButton className="text-xs text-destructive underline cursor-pointer">
                  Try again
                </ErrorBoundary.ResetButton>
              </div>
            }
          >
            <form
              className="flex items-center gap-2"
              action={async (formData: FormData) => {
                const { name, slug } = parseFormData(envSchema, formData);
                await createEnvAction({ name, slug, projectId });
                setShowNewRow(false);
              }}
            >
              <Input
                name={envFields.name}
                inputSize="sm"
                placeholder="Environment name"
                required
                className="flex-1"
              />
              <Input
                name={envFields.slug}
                inputSize="sm"
                placeholder="slug"
                required
                className="flex-1 mono-sm"
              />
              <Button size="xs" type="submit">
                Add
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setShowNewRow(false)}>
                Cancel
              </Button>
            </form>
          </ErrorBoundary>
        ) : (
          <button
            onClick={() => setShowNewRow(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1"
          >
            + Add Environment
          </button>
        )}
      </div>
    </Frame>
  );
}
