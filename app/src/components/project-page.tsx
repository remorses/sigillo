// Project detail page client component.
// Environment select on top right changes URL.
// Secrets table below with Doppler-style hidden values.

"use client";

import { useState } from "react";
import { getRouter } from "spiceflow/react";
import { SecretsTable } from "sigillo-app/src/components/secrets-table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "sigillo-app/src/components/ui/select";
import { Button } from "sigillo-app/src/components/ui/button";
import type { App } from "../app.tsx";

type Secret = {
  id: string;
  name: string;
  value: string;
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
  secrets,
  allSecretNames,
}: {
  projectId: string;
  projectName: string;
  orgId: string;
  environments: {
    id: string;
    name: string;
    slug: string;
    createdAt: number;
    updatedAt: number;
  }[];
  selectedEnvId: string | null;
  secrets: Secret[];
  allSecretNames: string[];
}) {
  const router = getRouter<App>();
  const [allVisible, setAllVisible] = useState(false);

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Header: project name + env select */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
        <div className="flex items-center gap-2">
          {secrets.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setAllVisible((v) => !v)}>
              {allVisible ? "Hide all secrets" : "Show all secrets"}
            </Button>
          )}
          <Select
            defaultValue={selectedEnvId || ""}
            onValueChange={(val) => {
              router.push(`/orgs/${orgId}/projects/${projectId}/envs/${val}`);
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-40">
              <SelectValue placeholder="Select environment">
                {environments.find((e) => e.id === selectedEnvId)?.name || "Select environment"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {env.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      {/* Secrets table */}
      {selectedEnvId ? (
        <SecretsTable
          secrets={secrets}
          environmentId={selectedEnvId}
          environments={environments}
          allVisible={allVisible}
          allSecretNames={allSecretNames}
        />
      ) : (
        <p className="text-muted-foreground text-sm">No environments yet.</p>
      )}
    </div>
  );
}
