// Secrets table with editable keys/values like Doppler.
// Values hidden by default (password inputs). Eye icon to reveal.
// Editing a key or value marks the row dirty. A "Save N secrets"
// button appears when there are unsaved changes.
// Import from .env file supported via file picker.

"use client";

import { EyeIcon, EyeOffIcon, TrashIcon, UploadIcon, PlusIcon, KeyIcon } from "lucide-react";
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
import { parseEnv } from "sigillo-app/src/lib/parse-env";

type Secret = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
};

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
        type="text"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        value={visible && hasValue ? currentValue : "••••••••••••"}
        onChange={(e) => {
          if (visible) {
            onValueChange(e.target.value);
          }
        }}
        readOnly={!visible}
        style={!visible ? { WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties : undefined}
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
  const router = getRouter();
  const [showNewRow, setShowNewRow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track edits per secret id
  const [edits, setEdits] = useState<Record<string, SecretEdits>>({});

  const setEdit = useCallback((id: string, field: "name" | "value", val: string) => {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: val },
    }));
  }, []);

  const dirtySecrets = secrets.filter((s) => {
    const e = edits[s.id];
    if (!e) return false;
    if (e.name !== undefined && e.name !== s.name) return true;
    if (e.value !== undefined) return true;
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

  const handleImportEnv = useCallback(async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = parseEnv(text);
      const entries = Object.entries(parsed);
      if (entries.length === 0) return;

      // Create each secret via the server action
      for (const [name, value] of entries) {
        const formData = new FormData();
        formData.set("environmentId", environmentId);
        formData.set("name", name);
        formData.set("value", value);
        await createSecretAction("", formData);
      }
      router.refresh();
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [environmentId, createSecretAction, router]);

  // Empty state
  if (secrets.length === 0 && !showNewRow) {
    return (
      <>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-muted mb-4">
            <KeyIcon className="size-6 text-muted-foreground" />
          </div>
          <h3 className="text-base font-semibold mb-1">No secrets yet</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-xs">
            Add secrets manually or import them from a .env file to get started.
          </p>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => setShowNewRow(true)}>
              <PlusIcon className="size-4" />
              Add Secret
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadIcon className="size-4" />
              Import .env
            </Button>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".env,.env.*,text/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleImportEnv(file);
          }}
        />
        {/* Inline add row for empty state */}
        {showNewRow && <AddSecretRow environmentId={environmentId} createSecretAction={createSecretAction} onDone={() => setShowNewRow(false)} />}
      </>
    );
  }

  return (
    <>
      <Frame className="w-full gap-3">
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
            {secrets.map((secret) => {
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
            })}
          </TableBody>
        </Table>

        <div className="border-t border-border"></div>
        {/* Bottom bar: add secret + import */}
        <div className="flex items-center justify-between px-1 pb-2">
          <div className="flex items-center gap-2 grow">
            {showNewRow ? (
              <AddSecretRow environmentId={environmentId} createSecretAction={createSecretAction} onDone={() => setShowNewRow(false)} />
            ) : (
              <button
                onClick={() => setShowNewRow(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1"
              >
                <PlusIcon className="size-3" />
                Add Secret
              </button>
            )}
          </div>
          {!showNewRow && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1 disabled:opacity-50"
            >
              <UploadIcon className="size-3" />
              {importing ? "Importing…" : "Import .env"}
            </button>
          )}
        </div>
      </Frame>

      <input
        ref={fileInputRef}
        type="file"
        accept=".env,.env.*,text/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportEnv(file);
        }}
      />

      {/* Save bar */}
      {dirtySecrets.length > 0 && (
        <div className="flex justify-end mt-3">
          <Button onClick={handleSave} loading={saving}>
            Save {dirtySecrets.length} secret{dirtySecrets.length > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </>
  );
}

function AddSecretRow({
  environmentId,
  createSecretAction,
  onDone,
}: {
  environmentId: string;
  createSecretAction: (prev: string, formData: FormData) => Promise<string>;
  onDone: () => void;
}) {
  return (
    <form
      className="flex items-center grow gap-2"
      action={async (formData: FormData) => {
        const result = await createSecretAction("", formData);
        if (result.startsWith("Created")) onDone();
      }}
    >
      <input type="hidden" name="environmentId" value={environmentId} />
      <input
        name="name"
        placeholder="SECRET_KEY"
        required
        className="h-7 flex-1 rounded-lg border border-input bg-background px-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        name="value"
        type="text"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        style={{ WebkitTextSecurity: 'disc', textSecurity: 'disc' } as React.CSSProperties}
        placeholder="secret value"
        required
        className="h-7 flex-1 rounded-lg border border-input bg-background px-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex-1" />
      <Button size="xs" type="submit">
        Add
      </Button>
      <Button size="xs" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}
