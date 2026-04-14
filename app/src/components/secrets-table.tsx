// Secrets table with editable keys/values like Doppler.
// Values hidden by default (password inputs). Eye icon to reveal.
// Editing a key or value marks the row dirty. A "Save N secrets"
// button appears when there are unsaved changes.
// Import from .env via a dialog with a textarea.

"use client";

import { EyeIcon, EyeOffIcon, TrashIcon, UploadIcon, PlusIcon, KeyIcon, CheckIcon } from "lucide-react";
import { useState, useCallback } from "react";
import { getRouter } from "spiceflow/react";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "sigillo-app/src/components/ui/table";
import { parseEnv } from "sigillo-app/src/lib/parse-env";
import {
  createSecretAction,
  deleteSecretAction,
  saveSecretsAction,
} from "../actions.ts";
import { App } from "../app.tsx";

type Secret = {
  id: string;
  name: string;
  value: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
};

const hiddenValueStyle: React.CSSProperties & {
  WebkitTextSecurity: string;
  textSecurity: string;
} = {
  WebkitTextSecurity: "disc",
  textSecurity: "disc",
};

const maskedInputStyle: React.CSSProperties & {
  WebkitTextSecurity: string;
  textSecurity: string;
} = {
  WebkitTextSecurity: "disc",
  textSecurity: "disc",
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
  value,
  editedValue,
  onValueChange,
  visible,
  onToggle,
}: {
  value: string;
  editedValue: string | undefined;
  onValueChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
}) {
  const displayValue = editedValue ?? value;

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="text"
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        value={visible ? displayValue : "••••••••••••"}
        onChange={(e) => {
          if (visible) {
            onValueChange(e.target.value);
          }
        }}
        readOnly={!visible}
        onFocus={(e) => {
          if (!visible) {
            e.target.blur()
            onToggle()
          }
        }}
        style={!visible ? hiddenValueStyle : undefined}
        className={`h-7 min-w-0 flex-1 rounded-md border px-2 text-sm font-mono ${visible ? 'border-input bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring' : 'border-transparent bg-muted/50 cursor-pointer select-none'}`}
      />
      <button
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground cursor-pointer"
        title={visible ? "Hide value" : "Reveal value"}
      >
        {visible ? (
          <EyeOffIcon className="size-4" />
        ) : (
          <EyeIcon className="size-4" />
        )}
      </button>
    </div>
  );
}

type Environment = { id: string; name: string; slug: string };

export function SecretsTable({
  secrets,
  environmentId,
  environments,
  allVisible,
}: {
  secrets: Secret[];
  environmentId: string;
  environments: Environment[];
  allVisible: boolean;
}) {
  const router = getRouter<App>();
  const [showNewRow, setShowNewRow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  // Per-row visibility overrides (only used when allVisible is false)
  const [rowVisible, setRowVisible] = useState<Record<string, boolean>>({});

  // Track edits per secret id
  const [edits, setEdits] = useState<Record<string, { name?: string; value?: string }>>({});

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

  const buildPayload = useCallback(() => {
    return dirtySecrets.map((s) => {
      const e = edits[s.id]!;
      return {
        id: s.id,
        // Always include the current name so cross-env upsert knows the key
        name: e.name !== undefined ? e.name : s.name,
        value: e.value,
      };
    });
  }, [dirtySecrets, edits]);

  const handleImportText = useCallback(async (text: string) => {
    const parsed = parseEnv(text);
    const entries = Object.entries(parsed);
    if (entries.length === 0) return;
    setImporting(true);
    try {
      for (const [name, value] of entries) {
        const formData = new FormData();
        formData.set("environmentId", environmentId);
        formData.set("name", name);
        formData.set("value", value);
        await createSecretAction("", formData);
      }
      setImportOpen(false);
      await router.refresh();
    } finally {
      setImporting(false);
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
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon className="size-4" />
              Import .env
            </Button>
          </div>
        </div>
        <ImportEnvDialog open={importOpen} onOpenChange={setImportOpen} importing={importing} onImport={handleImportText} />
        {/* Inline add row for empty state */}
        {showNewRow && <AddSecretRow environmentId={environmentId} onDone={() => setShowNewRow(false)} />}
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
              const isVisible = allVisible || (rowVisible[secret.id] ?? false);
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
                      value={secret.value}
                      editedValue={edits[secret.id]?.value}
                      onValueChange={(v) => setEdit(secret.id, "value", v)}
                      visible={isVisible}
                      onToggle={() => setRowVisible((prev) => ({ ...prev, [secret.id]: !isVisible }))}
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
              <AddSecretRow environmentId={environmentId} onDone={() => setShowNewRow(false)} />
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
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer px-2 py-1"
            >
              <UploadIcon className="size-3" />
              Import .env
            </button>
          )}
        </div>
      </Frame>

      <ImportEnvDialog open={importOpen} onOpenChange={setImportOpen} importing={importing} onImport={handleImportText} />

      <SaveToEnvsDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        environments={environments}
        currentEnvId={environmentId}
        dirtyCount={dirtySecrets.length}
        saving={saving}
        onSave={async (envIds) => {
          setSaving(true);
          try {
            await saveSecretsAction(buildPayload(), envIds);
            setEdits({});
            setSaveOpen(false);
            await router.refresh();
          } finally {
            setSaving(false);
          }
        }}
      />

      {/* Save bar */}
      {dirtySecrets.length > 0 && (
        <div className="flex justify-end mt-3">
          <Button onClick={() => setSaveOpen(true)}>
            Save {dirtySecrets.length} secret{dirtySecrets.length > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </>
  );
}

function ImportEnvDialog({
  open,
  onOpenChange,
  importing,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importing: boolean;
  onImport: (text: string) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Import .env</DialogTitle>
          <DialogDescription>
            Paste your .env file contents below. Each line should be in KEY=value format.
          </DialogDescription>
        </DialogHeader>
        <form
          className="px-6 pb-2"
          action={async (formData: FormData) => {
            const textValue = formData.get("envText");
            const text = typeof textValue === "string" ? textValue : "";
            if (text.trim()) await onImport(text);
          }}
        >
          <textarea
            name="envText"
            required
            autoFocus
            placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=sk-...\nSECRET_TOKEN=abc123"}
            rows={8}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" loading={importing}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function SaveToEnvsDialog({
  open,
  onOpenChange,
  environments,
  currentEnvId,
  dirtyCount,
  saving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environments: Environment[];
  currentEnvId: string;
  dirtyCount: number;
  saving: boolean;
  onSave: (envIds: string[]) => Promise<void>;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  // Current env is always first and checked, others default to unchecked
  const toggle = (id: string) => setChecked((prev) => ({ ...prev, [id]: !prev[id] }));

  const selectedIds = [
    currentEnvId,
    ...environments.filter((e) => e.id !== currentEnvId && checked[e.id]).map((e) => e.id),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Save {dirtyCount} secret{dirtyCount > 1 ? "s" : ""}</DialogTitle>
          <DialogDescription>
            Choose which environments to apply the changes to.
            Secrets are matched by name — missing keys will be created.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-2 flex flex-col gap-1.5">
          {environments.map((env) => {
            const isCurrent = env.id === currentEnvId;
            const isChecked = isCurrent || (checked[env.id] ?? false);
            return (
              <label
                key={env.id}
                className={`flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors ${isChecked ? "bg-primary/5" : "hover:bg-muted/50"} ${isCurrent ? "opacity-80" : ""}`}
              >
                <span
                  className={`flex items-center justify-center size-4 rounded border transition-colors ${isChecked ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}
                  aria-hidden
                >
                  {isChecked && <CheckIcon className="size-3" />}
                </span>
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isCurrent}
                  onChange={() => toggle(env.id)}
                  className="sr-only"
                />
                <span className="text-sm font-medium">{env.name}</span>
                {isCurrent && <span className="text-xs text-muted-foreground ml-auto">current</span>}
              </label>
            );
          })}
        </div>
        <DialogFooter variant="bare" className="px-6 pb-4 pt-2">
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button loading={saving} onClick={() => onSave(selectedIds)}>
            Save to {selectedIds.length} environment{selectedIds.length > 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AddSecretRow({
  environmentId,
  onDone,
}: {
  environmentId: string;
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
        style={maskedInputStyle}
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
