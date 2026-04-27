// Environments table for a project (standalone tab).
// Shows name, slug, timestamps. Supports inline rename, delete, and add.
// All environments are user-managed — no hardcoded "default" protection.

"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { PencilIcon, TrashIcon } from "lucide-react";
import { useState, useRef } from "react";
import { z } from "zod";
import { parseFormData } from "spiceflow";
import { ErrorBoundary, useLoaderData } from "spiceflow/react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { cn } from "sigillo-app/src/lib/utils";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input } from "sigillo-app/src/components/ui/input";
import { formatTime } from "sigillo-app/src/lib/utils";
import { createEnvAction, deleteEnvAction, renameEnvAction } from "../actions.ts";
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
  createdAt: number;
  updatedAt: number;
};

const knownEnvColors: Record<string, string> = {
  development: "bg-blue-500",
  dev: "bg-blue-500",
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

function getEnvColor(name: string, slug: string): string {
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
      await renameEnvAction({ id: env.id, [field]: trimmed });
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
          className={cn("h-7 w-full", field === "slug" && "font-mono")}
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
          <span className="font-mono">{env.slug}</span>
        </Badge>
      )}
      <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
}

const envSchema = z.object({ name: z.string().min(1, "Name is required"), slug: z.string().min(1, "Slug is required") });
const envFields = envSchema.keyof().enum;

export function EnvironmentsPage() {
  const { projectId, projectName, environments } = useLoaderData('/orgs/:orgId/projects/:projectId/environments');

  return (
    <div className="flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
      </div>
      <EnvironmentsTable environments={environments} projectId={projectId} />
    </div>
  );
}

export function EnvironmentsTable({
  environments,
  projectId,
}: {
  environments: Environment[];
  projectId: string;
}) {
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
      accessorKey: "updatedAt",
      header: "Last Updated",
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatTime(row.original.updatedAt)}
        </span>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      size: 130,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatTime(row.original.createdAt)}
        </span>
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
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground py-8">
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
                className="flex-1 font-mono"
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
