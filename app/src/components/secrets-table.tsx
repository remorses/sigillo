// Secrets table with editable keys/values like Doppler.
// Values hidden by default (password inputs). Eye icon to reveal.
// Editing a key or value marks the row dirty. A "Save N secrets"
// button appears when there are unsaved changes.
// Import from .env via a dialog with a textarea, and export current secrets
// back to .env via download or copy.

"use client";

import { EyeIcon, EyeOffIcon, TrashIcon, UploadIcon, PlusIcon, KeyIcon, CheckIcon, DownloadIcon, CopyIcon } from "lucide-react";
import { EmptyState } from "sigillo-app/src/components/ui/empty-state";
import { useState, useCallback } from "react";
import { z } from "zod";
import { parseFormData } from "spiceflow";
import { ErrorBoundary } from "spiceflow/react";
import { cn } from "sigillo-app/src/lib/utils";
import { Button } from "sigillo-app/src/components/ui/button";
import { Frame } from "sigillo-app/src/components/ui/frame";
import { Input, Textarea } from "sigillo-app/src/components/ui/input";
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
import { formatTime } from "sigillo-app/src/lib/utils";
import {
  createSecretAction,
  deleteSecretAction,
  saveSecretsAction,
} from "../actions.ts";


type Secret = {
  id: string;
  name: string;
  value: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
};

// Secret values use the .text-security-disc CSS class from globals.css
// instead of inline style objects (eliminates duplication with event-log-table).

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
    <div className="flex w-full min-w-0 items-center gap-1.5">
      <Input
        type="text"
        inputSize="sm"
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
        className={cn(
          "min-w-0 max-w-full flex-1 font-mono",
          visible ? "bg-muted/50" : "text-security-disc border-transparent bg-muted/50 cursor-pointer select-none",
        )}
      />
      <button
        onClick={onToggle}
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
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
  allSecretNames,
}: {
  secrets: Secret[];
  environmentId: string;
  environments: Environment[];
  allVisible: boolean;
  allSecretNames: string[];
}) {
  const [showNewRow, setShowNewRow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  // Per-row visibility overrides (only used when allVisible is false)
  const [rowVisible, setRowVisible] = useState<Record<string, boolean>>({});

  // Track edits per secret id
  const [edits, setEdits] = useState<Record<string, { name?: string; value?: string }>>({});
  // Track values typed into missing-key rows (keyed by secret name)
  const [missingEdits, setMissingEdits] = useState<Record<string, string>>({});

  const setEdit = useCallback((id: string, field: "name" | "value", val: string) => {
    setEdits((prev) => ({
      ...prev,
      [id]: { ...prev[id], [field]: val },
    }));
  }, []);

  // Keys that exist in other envs but not in this one
  // Use edited names so renaming a secret to a missing key hides the red row
  const effectiveNames = new Set(
    secrets.map((s) => edits[s.id]?.name ?? s.name).filter(Boolean)
  );
  const missingKeys = allSecretNames.filter((name) => !effectiveNames.has(name));

  const dirtySecrets = secrets.filter((s) => {
    const e = edits[s.id];
    if (!e) return false;
    if (e.name !== undefined && e.name !== s.name) return true;
    if (e.value !== undefined) return true;
    return false;
  });

  // Missing keys that have a value typed in
  const dirtyMissingKeys = missingKeys.filter((name) => missingEdits[name]?.trim());

  const totalDirtyCount = dirtySecrets.length + dirtyMissingKeys.length;

  const currentEnvEntries: Array<[string, string]> = [
    ...secrets.map<[string, string]>((secret) => [
      edits[secret.id]?.name ?? secret.name,
      edits[secret.id]?.value ?? secret.value,
    ]),
    ...dirtyMissingKeys.map<[string, string]>((name) => [name, missingEdits[name]!]),
  ];
  const envFileText = currentEnvEntries
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join("\n") + "\n";

  const buildPayload = useCallback(() => {
    return dirtySecrets.map((s) => {
      const e = edits[s.id]!;
      return {
        // originalName is the key before any rename — used for event sourcing
        originalName: s.name,
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
        await createSecretAction({ name, value, environmentId });
      }
      setImportOpen(false);
    } catch (e: any) {
      alert(e?.message || "Failed to import secrets");
    } finally {
      setImporting(false);
    }
  }, [environmentId]);

  const handleDownloadEnv = useCallback(() => {
    const blob = new Blob([envFileText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `.env.${environments.find((env) => env.id === environmentId)?.slug ?? "env"}`;
    link.click();
    URL.revokeObjectURL(url);
  }, [envFileText, environmentId, environments]);

  const handleCopyEnv = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(envFileText);
    } catch (error: any) {
      alert(error?.message || "Failed to copy .env contents");
    }
  }, [envFileText]);

  // Empty state (only show when no secrets AND no missing keys from other envs)
  if (secrets.length === 0 && missingKeys.length === 0 && !showNewRow) {
    return (
      <>
        <EmptyState
          icon={<KeyIcon className="size-6 text-muted-foreground" />}
          title="No secrets yet"
          description="Add secrets manually or import them from a .env file to get started."
        >
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
        </EmptyState>
        <ImportEnvDialog open={importOpen} onOpenChange={setImportOpen} importing={importing} onImport={handleImportText} />
        {/* Inline add row for empty state */}
        {showNewRow && <AddSecretRow environmentId={environmentId} onDone={() => setShowNewRow(false)} />}
      </>
    );
  }

  return (
    <>
      <Frame className="w-full gap-3">
        <Table>
          <colgroup>
            <col />
            <col />
            <col className="w-32" />
            <col className="w-16" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="whitespace-normal">Key</TableHead>
              <TableHead className="whitespace-normal">Value</TableHead>
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
                  <TableCell className="min-w-0 overflow-hidden">
                    <Input
                      type="text"
                      inputSize="sm"
                      value={edits[secret.id]?.name ?? secret.name}
                      onChange={(e) => setEdit(secret.id, "name", e.target.value)}
                      className="w-full min-w-0 border-transparent bg-transparent px-1.5 font-mono font-medium focus:border-input hover:border-input"
                    />
                  </TableCell>
                  <TableCell className="min-w-0 overflow-hidden">
                    <SecretValueCell
                      value={secret.value}
                      editedValue={edits[secret.id]?.value}
                      onValueChange={(v) => setEdit(secret.id, "value", v)}
                      visible={isVisible}
                      onToggle={() => setRowVisible((prev) => ({ ...prev, [secret.id]: !isVisible }))}
                    />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {formatTime(secret.updatedAt)}
                    </span>
                  </TableCell>
                  <TableCell className="p-0">
                    <button
                      onClick={async () => {
                        if (confirm(`Delete secret "${secret.name}"?`)) {
                          try {
                            await deleteSecretAction({ name: secret.name, environmentId });
                          } catch (e: any) {
                            alert(e?.message || "Failed to delete secret");
                          }
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
            {/* Missing keys: exist in other envs but not this one */}
            {missingKeys.map((name) => {
              const hasValue = missingEdits[name]?.trim();
              return (
                <TableRow key={`missing-${name}`} className="bg-destructive/5 dark:bg-destructive/10">
                  <TableCell className="min-w-0 whitespace-normal">
                    <span className="block break-all px-1.5 font-mono text-sm font-medium text-destructive">
                      {name}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-0 overflow-hidden">
                    <Input
                      type="text"
                      inputSize="sm"
                      autoComplete="off"
                      data-1p-ignore
                      data-lpignore="true"
                      placeholder="Missing — add a value"
                      value={missingEdits[name] ?? ""}
                      onChange={(e) => setMissingEdits((prev) => ({ ...prev, [name]: e.target.value }))}
                       className={cn(
                         "w-full min-w-0 font-mono border-destructive/40",
                         hasValue ? "bg-amber-50/50 dark:bg-amber-950/20" : "text-security-disc bg-transparent",
                       )}
                     />
                   </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <span className="text-destructive text-xs">missing</span>
                  </TableCell>
                  <TableCell />
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        {/*<div className="border-t border-border"></div>*/}
        {/* Bottom bar: add secret + import */}
        <div className="flex items-center justify-between gap-2 px-1 pb-2">
          {!showNewRow ? (
            <div className="flex items-center gap-1">
              <Button
                onClick={() => setImportOpen(true)}
                size="xs"
                variant="ghost"
              >
                <UploadIcon className="size-3" />
                Import .env
              </Button>
              <Button
                onClick={handleDownloadEnv}
                size="xs"
                variant="ghost"
              >
                <DownloadIcon className="size-3" />
                Download .env
              </Button>
              <Button
                onClick={() => void handleCopyEnv()}
                size="xs"
                variant="ghost"
              >
                <CopyIcon className="size-3" />
                Copy as .env
              </Button>
            </div>
          ) : (
            <div />
          )}

          <div className="flex grow justify-end items-center gap-2">
            {showNewRow ? (
              <AddSecretRow environmentId={environmentId} onDone={() => setShowNewRow(false)} />
            ) : (
              <Button
                onClick={() => setShowNewRow(true)}
                size="xs"
              >
                <PlusIcon className="size-3" />
                Add Secret
              </Button>
            )}
          </div>
        </div>
      </Frame>

      <ImportEnvDialog open={importOpen} onOpenChange={setImportOpen} importing={importing} onImport={handleImportText} />

      <SaveToEnvsDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        environments={environments}
        currentEnvId={environmentId}
        dirtyCount={totalDirtyCount}
        saving={saving}
        onSave={async (envIds) => {
          setSaving(true);
          try {
            // Save existing secret edits
            if (dirtySecrets.length > 0) {
              await saveSecretsAction({ edits: buildPayload(), environmentIds: envIds });
            }
            // Create missing keys that have values typed in (honor selected envs)
            for (const envId of envIds) {
              for (const name of dirtyMissingKeys) {
                await createSecretAction({ name, value: missingEdits[name]!, environmentId: envId });
              }
            }
            setEdits({});
            setMissingEdits({});
            setSaveOpen(false);
          } catch (e: any) {
            alert(e?.message || "Failed to save secrets");
          } finally {
            setSaving(false);
          }
        }}
      />

      {/* Save bar */}
      {totalDirtyCount > 0 && (
        <div className="flex justify-end mt-3">
          <Button onClick={() => setSaveOpen(true)}>
            Save {totalDirtyCount} secret{totalDirtyCount > 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </>
  );
}

const importEnvSchema = z.object({ envText: z.string().min(1, "Paste your .env contents") });
const importEnvFields = importEnvSchema.keyof().enum;

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
            const { envText } = parseFormData(importEnvSchema, formData);
            if (envText.trim()) await onImport(envText);
          }}
        >
          <Textarea
            name={importEnvFields.envText}
            required
            autoFocus
            placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=sk-...\nSECRET_TOKEN=abc123"}
            rows={8}
            className="font-mono"
          />
          <DialogFooter variant="bare" className="mt-4">
            <DialogClose render={<Button variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit">
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
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors",
                  isChecked ? "bg-primary/5" : "hover:bg-muted/50",
                  isCurrent && "opacity-80",
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center size-4 rounded border transition-colors",
                    isChecked ? "bg-primary border-primary text-primary-foreground" : "border-input",
                  )}
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

const addSecretSchema = z.object({ name: z.string().min(1, "Key is required"), value: z.string().min(1, "Value is required") });
const addSecretFields = addSecretSchema.keyof().enum;

function AddSecretRow({
  environmentId,
  onDone,
}: {
  environmentId: string;
  onDone: () => void;
}) {
  return (
    <ErrorBoundary
      fallback={
        <div className="flex items-center grow gap-2">
          <ErrorBoundary.ErrorMessage className="text-xs text-destructive" />
          <ErrorBoundary.ResetButton className="text-xs text-destructive underline cursor-pointer">
            Try again
          </ErrorBoundary.ResetButton>
        </div>
      }
    >
      <form
        className="flex items-center grow gap-2"
        action={async (formData: FormData) => {
          const { name, value } = parseFormData(addSecretSchema, formData);
          await createSecretAction({ name, value, environmentId });
          onDone();
        }}
      >
        <Input
          name={addSecretFields.name}
          placeholder="SECRET_KEY"
          required
          autoFocus
          className="flex-1 font-mono"
        />
        <Input
          name={addSecretFields.value}
          type="text"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
      placeholder="secret value"
          required
      className="flex-1 font-mono text-security-disc"
    />
    <div className="flex-1" />
        <Button size="sm" type="submit">
          Add
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </form>
    </ErrorBoundary>
  );
}
