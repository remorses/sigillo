// Secrets table with hidden values like Doppler.
// Keys are shown as text inputs, values as password inputs (hidden by default).
// Toggle eye icon to reveal. Shows created/updated timestamps.

"use client";

import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { EyeIcon, EyeOffIcon, TrashIcon } from "lucide-react";
import { useState, useCallback } from "react";
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

type Secret = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
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

function SecretValueCell({ secretId }: { secretId: string }) {
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (!visible && value === null) {
      setLoading(true);
      try {
        const resp = await fetch(`/api/secrets/${secretId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { value: string };
        setValue(data.value);
        setVisible(true);
      } catch (err) {
        console.error("Failed to fetch secret value:", err);
      } finally {
        setLoading(false);
      }
      return;
    }
    setVisible((v) => !v);
  }, [visible, value, secretId]);

  return (
    <div className="flex items-center gap-1.5">
      <input
        type={visible ? "text" : "password"}
        value={visible && value !== null ? value : "••••••••••••"}
        readOnly
        className="h-7 w-48 rounded-md border border-input bg-muted/50 px-2 text-sm font-mono focus:outline-none"
      />
      <button
        onClick={toggle}
        disabled={loading}
        className="text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50"
        title={visible ? "Hide value" : "Reveal value"}
      >
        {loading ? (
          <span className="size-4 block animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        ) : visible ? (
          <EyeOffIcon className="size-4" />
        ) : (
          <EyeIcon className="size-4" />
        )}
      </button>
    </div>
  );
}

export function SecretsTable({
  secrets,
  environmentId,
  deleteSecretAction,
  createSecretAction,
}: {
  secrets: Secret[];
  environmentId: string;
  deleteSecretAction: (id: string) => Promise<void>;
  createSecretAction: (prev: string, formData: FormData) => Promise<string>;
}) {
  const [showNewRow, setShowNewRow] = useState(false);
  const [message, setMessage] = useState("");

  const columns: ColumnDef<Secret>[] = [
    {
      accessorKey: "name",
      header: "Key",
      size: 200,
      cell: ({ row }) => (
        <div className="font-mono text-sm font-medium">
          {row.getValue("name")}
        </div>
      ),
    },
    {
      id: "value",
      header: "Value",
      size: 280,
      cell: ({ row }) => (
        <SecretValueCell secretId={row.original.id} />
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
      cell: ({ row }) => (
        <button
          onClick={async () => {
            if (confirm(`Delete secret "${row.original.name}"?`)) {
              await deleteSecretAction(row.original.id);
            }
          }}
          className="text-muted-foreground hover:text-destructive cursor-pointer"
          title="Delete secret"
        >
          <TrashIcon className="size-3.5" />
        </button>
      ),
    },
  ];

  const table = useReactTable({
    columns,
    data: secrets,
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
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell className="h-16 text-center text-muted-foreground" colSpan={columns.length}>
                No secrets in this environment yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {/* Add new secret row */}
      <div className="p-2 border-t border-border">
        {showNewRow ? (
          <form
            className="flex items-center gap-2"
            action={async (formData: FormData) => {
              const result = await createSecretAction("", formData);
              setMessage(result);
              if (result.startsWith("Created")) setShowNewRow(false);
            }}
          >
            <input type="hidden" name="environmentId" value={environmentId} />
            <input
              name="name"
              placeholder="SECRET_KEY"
              required
              className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <input
              name="value"
              type="password"
              placeholder="secret value"
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
            + Add Secret
          </button>
        )}
        {message && <p className="text-xs text-muted-foreground px-2 mt-1">{message}</p>}
      </div>
    </Frame>
  );
}
