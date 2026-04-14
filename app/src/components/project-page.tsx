// Project detail page client component.
// Environment select on top right changes URL.
// Secrets table below with Doppler-style hidden values.

"use client";

import { useState, useCallback } from "react";
import { getRouter } from "spiceflow/react";
import { SecretsTable } from "sigillo-app/src/components/secrets-table";
import type { App } from "../app.tsx";

type Environment = {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
};

type Secret = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
};

export function ProjectPage({
  projectId,
  projectName,
  orgId,
  environments,
  selectedEnvId,
  secrets: initialSecrets,
  fetchSecretsForEnv,
  deleteSecretAction,
  createSecretAction,
  saveSecretsAction,
}: {
  projectId: string;
  projectName: string;
  orgId: string;
  environments: Environment[];
  selectedEnvId: string | null;
  secrets: Secret[];
  fetchSecretsForEnv: (envId: string) => Promise<Secret[]>;
  deleteSecretAction: (id: string) => Promise<void>;
  createSecretAction: (prev: string, formData: FormData) => Promise<string>;
  saveSecretsAction: (edits: { id: string; name?: string; value?: string }[]) => Promise<void>;
}) {
  const router = getRouter<App>();
  const [secrets, setSecrets] = useState<Secret[]>(initialSecrets);

  const refreshSecrets = useCallback(async () => {
    if (!selectedEnvId) return;
    const s = await fetchSecretsForEnv(selectedEnvId);
    setSecrets(s);
  }, [selectedEnvId, fetchSecretsForEnv]);

  const wrappedCreateSecret = useCallback(async (prev: string, formData: FormData) => {
    const result = await createSecretAction(prev, formData);
    if (result.startsWith("Created")) {
      await refreshSecrets();
    }
    return result;
  }, [createSecretAction, refreshSecrets]);

  const wrappedDeleteSecret = useCallback(async (id: string) => {
    await deleteSecretAction(id);
    await refreshSecrets();
  }, [deleteSecretAction, refreshSecrets]);

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Header: project name + env select */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 pr-8 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring"
          value={selectedEnvId || ""}
          onChange={(e) => {
            router.push(`/projects/${projectId}?orgId=${orgId}&envId=${e.target.value}`);
          }}
        >
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
      </div>

      {/* Secrets table */}
      {selectedEnvId ? (
        <SecretsTable
          secrets={secrets}
          environmentId={selectedEnvId}
          deleteSecretAction={wrappedDeleteSecret}
          createSecretAction={wrappedCreateSecret}
          saveSecretsAction={saveSecretsAction}
        />
      ) : (
        <p className="text-muted-foreground text-sm">No environments yet.</p>
      )}
    </div>
  );
}
