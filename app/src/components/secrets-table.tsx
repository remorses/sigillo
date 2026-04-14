// Secrets table with editable keys/values like Doppler.
// Values hidden by default (password inputs). Eye icon to reveal.
// Editing a key or value marks the row dirty. A floating "Save N secrets"
// button appears when there are unsaved changes.

"use client";

import { EyeIcon, EyeOffIcon, TrashIcon } from "lucide-react";
import { useState, useCallback, useRef } from "react";
import { getRouter } from "spiceflow/react";
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
import type { App } from "../app.tsx";

type Secret = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
};

// Per-row edits: tracks changed key and/or value
type SecretEdits = {
  name?: string;
  value?: string;
};

function formatTime(ts: number) {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function SecretValueCell({
  secretId,
  editedValue,
  onValueChange,
}: {
  secretId: string;
  editedValue: string | undefined;
  onValueChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const [fetchedValue, setFetchedValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // The displayed value: edited > fetched > hidden dots
  const currentValue = editedValue ?? fetchedValue;
  const hasValue = currentValue !== null && currentValue !== undefined;

  const toggle = useCallback(async () => {
    if (!visible && fetchedValue === null && editedValue === undefined) {
      setLoading(true);
      try {
        const resp = await fetch(`/api/secrets/${secretId}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { value: string };
        setFetchedValue(data.value);
        setVisible(true);
      } catch (err) {
        console.error("Failed to fetch secret value:", err);
      } finally {
        setLoading(false);
      }
      return;
    }
    setVisible((v) => !v);
  }, [visible, fetchedValue, editedValue, secretId]);

  return (
    <div className="flex items-center gap-1.5">
      <input
        type={visible ? "text" : "password"}
        value={visible && hasValue ? currentValue : "••••••••••••"}
        onChange={(e) => {
          if (visible) {
            onValueChange(e.target.value);
          }
        }}
        readOnly={!visible}
        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-muted/50 px-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
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
  saveSecretsAction,
}: {
  secrets: Secret[];
  environmentId: string;
  deleteSecretAction: (id: string) => Promise<void>;
  createSecretAction: (prev: string, formData: FormData) => Promise<string>;
  saveSecretsAction: (edits: { id: string; name?: string; value?: string }[]) => Promise<void>;
}) {
  const router = getRouter<App>();
  const [showNewRow, setShowNewRow] = useState(false);
  const [saving, setSaving] = useState(false);

  // Track edits per secret id
  const [edits, setEdits] = useState<Record<string, SecretEdits>>({});

  const setEdit = useCallback((id: string, field: "name" | "value", val: string) => {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: val },
    }));
  }, []);

  // Compute dirty secrets: only those with actual changes
  const dirtySecrets = secrets.filter((s) => {
    const e = edits[s.id];
    if (!e) return false;
    if (e.name !== undefined && e.name !== s.name) return true;
    if (e.value !== undefined) return true; // can't compare — original is encrypted
    return false;
  });

  const handleSave = useCallback(async () => {
    if (dirtySecrets.length === 0) return;
    setSaving(true);
    try {
      const payload = dirtySecrets.map((s) => {
        const e = edits[s.id]!;
        return {
          id: s.id,
          name: e.name !== undefined && e.name !== s.name ? e.name : undefined,
          value: e.value,
        };
      });
      await saveSecretsAction(payload);
      setEdits({});
      router.refresh();
    } finally {
      setSaving(false);
    }
  }, [dirtySecrets, edits, saveSecretsAction, router]);

  return (
    <>
      <Frame className="w-full">
        <Table className="table-fixed">
          <colgroup>
            <col className="w-1/4" />
            <col style={{ width: "500px" }} />
            <col className="w-32" />
            <col className="w-16" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Key</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.length ? (
              secrets.map((secret) => {
                const isDirty = dirtySecrets.includes(secret);
                return (
                  <TableRow key={secret.id} className={isDirty ? "bg-amber-50/50 dark:bg-amber-950/20" : ""}>
                    <TableCell>
                      <input
                        type="text"
                        value={edits[secret.id]?.name ?? secret.name}
                        onChange={(e) => setEdit(secret.id, "name", e.target.value)}
                        className="h-7 w-full rounded-md border border-transparent bg-transparent px-1.5 text-sm font-mono font-medium focus:border-input focus:outline-none focus:ring-2 focus:ring-ring hover:border-input"
                      />
                    </TableCell>
                    <TableCell>
                      <SecretValueCell
                        secretId={secret.id}
                        editedValue={edits[secret.id]?.value}
                        onValueChange={(v) => setEdit(secret.id, "value", v)}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatTime(secret.updatedAt)}
                      </span>
                    </TableCell>
                    <TableCell className="p-0">
                      <button
                        onClick={async () => {
                          if (confirm(`Delete secret "${secret.name}"?`)) {
                            await deleteSecretAction(secret.id);
                          }
                        }}
                        className="text-muted-foreground hover:text-destructive cursor-pointer"
                        title="Delete secret"
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell className="h-16 text-center text-muted-foreground" colSpan={4}>
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
        </div>
      </Frame>

      {/* Floating save bar */}
      {dirtySecrets.length > 0 && (
        <div className="fixed bottom-6 right-6 z-50">
          <Button
            onClick={handleSave}
            loading={saving}
            className="shadow-lg"
          >
            Save {dirtySecrets.length} secret{dirtySecrets.length > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </>
  );
}
