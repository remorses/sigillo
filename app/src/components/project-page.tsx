// Project detail page client component.
// Environment select on top right changes URL.
// Secrets table below with Doppler-style hidden values.

"use client";

import { useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { getRouter } from "spiceflow/react";
import { SecretsTable } from "sigillo-app/src/components/secrets-table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "sigillo-app/src/components/ui/select";
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
            <button
              onClick={() => setAllVisible((v) => !v)}
              className="text-muted-foreground hover:text-foreground cursor-pointer p-1.5 rounded-md hover:bg-muted transition-colors"
              title={allVisible ? "Hide all values" : "Reveal all values"}
            >
              {allVisible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </button>
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
          allVisible={allVisible}
        />
      ) : (
        <p className="text-muted-foreground text-sm">No environments yet.</p>
      )}
    </div>
  );
}
