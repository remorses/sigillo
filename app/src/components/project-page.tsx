// Project detail page client component.
// Shows environments table and secrets table side by side / stacked.
// Selecting an environment loads its secrets.

"use client";

import { useState, useCallback } from "react";
import { EnvironmentsTable } from "sigillo-app/src/components/environments-table";
import { SecretsTable } from "sigillo-app/src/components/secrets-table";

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
  projectName,
  environments,
  initialEnvId,
  initialSecrets,
  fetchSecretsForEnv,
  deleteSecretAction,
  createSecretAction,
  deleteEnvAction,
  createEnvAction,
}: {
  projectName: string;
  environments: Environment[];
  initialEnvId: string | null;
  initialSecrets: Secret[];
  fetchSecretsForEnv: (envId: string) => Promise<Secret[]>;
  deleteSecretAction: (id: string) => Promise<void>;
  createSecretAction: (prev: string, formData: FormData) => Promise<string>;
  deleteEnvAction: (id: string) => Promise<void>;
  createEnvAction: (prev: string, formData: FormData) => Promise<string>;
}) {
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(initialEnvId);
  const [secrets, setSecrets] = useState<Secret[]>(initialSecrets);
  const [loadingSecrets, setLoadingSecrets] = useState(false);

  const refreshSecrets = useCallback(async (envId?: string) => {
    const id = envId || selectedEnvId;
    if (!id) return;
    const s = await fetchSecretsForEnv(id);
    setSecrets(s);
  }, [selectedEnvId, fetchSecretsForEnv]);

  const handleSelectEnv = useCallback(
    async (envId: string) => {
      if (envId === selectedEnvId) return;
      setSelectedEnvId(envId);
      setLoadingSecrets(true);
      try {
        const s = await fetchSecretsForEnv(envId);
        setSecrets(s);
      } finally {
        setLoadingSecrets(false);
      }
    },
    [selectedEnvId, fetchSecretsForEnv],
  );

  // Wrap create/delete to refresh after mutation
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

  const selectedEnv = environments.find((e) => e.id === selectedEnvId);

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Environments */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Environments</h2>
        <EnvironmentsTable
          environments={environments}
          selectedEnvId={selectedEnvId}
          onSelectEnv={handleSelectEnv}
          deleteEnvAction={deleteEnvAction}
          createEnvAction={createEnvAction}
        />
      </section>

      {/* Secrets for selected environment */}
      {selectedEnvId && (
        <section>
          <h2 className="text-lg font-semibold mb-3">
            Secrets
            {selectedEnv && (
              <span className="text-muted-foreground font-normal text-base ml-2">
                — {selectedEnv.name}
              </span>
            )}
          </h2>
          {loadingSecrets ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              Loading secrets…
            </div>
          ) : (
            <SecretsTable
              secrets={secrets}
              environmentId={selectedEnvId}
              deleteSecretAction={wrappedDeleteSecret}
              createSecretAction={wrappedCreateSecret}
            />
          )}
        </section>
      )}
    </div>
  );
}
