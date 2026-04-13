// Environments table for a project.
// Shows name, slug, secret count, created/updated timestamps.

"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { TrashIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
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

function formatTime(ts: number) {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const envColors: Record<string, string> = {
  development: "bg-blue-500",
  preview: "bg-amber-500",
  production: "bg-emerald-500",
};

export function EnvironmentsTable({
  environments,
  selectedEnvId,
  onSelectEnv,
  deleteEnvAction,
  createEnvAction,
}: {
  environments: Environment[];
  selectedEnvId: string | null;
  onSelectEnv: (envId: string) => void;
  deleteEnvAction: (id: string) => Promise<void>;
  createEnvAction: (prev: string, formData: FormData) => Promise<string>;
}) {
  const [showNewRow, setShowNewRow] = useState(false);
  const [message, setMessage] = useState("");

  const columns: ColumnDef<Environment>[] = [
    {
      accessorKey: "name",
      header: "Environment",
      size: 180,
      cell: ({ row }) => (
        <button
          onClick={() => onSelectEnv(row.original.id)}
          className={`flex items-center gap-2 cursor-pointer ${
            selectedEnvId === row.original.id ? "font-semibold" : ""
          }`}
        >
          <span
            className={`size-2 rounded-full ${envColors[row.original.slug] || "bg-muted-foreground"}`}
          />
          {row.getValue("name")}
        </button>
      ),
    },
    {
      accessorKey: "slug",
      header: "Slug",
      size: 130,
      cell: ({ row }) => (
        <Badge variant="outline" size="default">
          <span className="font-mono">{row.getValue("slug")}</span>
        </Badge>
      ),
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
      cell: ({ row }) => {
        const isDefault = ["development", "preview", "production"].includes(row.original.slug);
        if (isDefault) return null;
        return (
          <button
            onClick={async () => {
              if (confirm(`Delete environment "${row.original.name}"?`)) {
                await deleteEnvAction(row.original.id);
              }
            }}
            className="text-muted-foreground hover:text-destructive cursor-pointer"
            title="Delete environment"
          >
            <TrashIcon className="size-3.5" />
          </button>
        );
      },
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
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              data-state={selectedEnvId === row.original.id ? "selected" : undefined}
              className="cursor-pointer"
              onClick={() => onSelectEnv(row.original.id)}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="p-2 border-t border-border">
        {showNewRow ? (
          <form
            className="flex items-center gap-2"
            action={async (formData: FormData) => {
              const result = await createEnvAction("", formData);
              setMessage(result);
              if (result.startsWith("Created")) setShowNewRow(false);
            }}
          >
            <input
              name="name"
              placeholder="Environment name"
              required
              className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              name="slug"
              placeholder="slug"
              required
              className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <Button size="xs" type="submit">
              Add
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setShowNewRow(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <button
            onClick={() => setShowNewRow(true)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1"
          >
            + Add Environment
          </button>
        )}
        {message && <p className="text-xs text-muted-foreground px-2 mt-1">{message}</p>}
      </div>
    </Frame>
  );
}
