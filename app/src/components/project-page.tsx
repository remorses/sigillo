// Project detail page client component.
// Environment select on top right changes URL.
// Secrets table below with Doppler-style hidden values.

"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { SecretsTable } from "sigillo-app/src/components/secrets-table";
import { Button } from "sigillo-app/src/components/ui/button";
import { FramePanel } from "sigillo-app/src/components/ui/frame";
import {
    Select,
    SelectItem,
    SelectPopup,
    SelectTrigger,
    SelectValue,
} from "sigillo-app/src/components/ui/select";
import { getRouter } from "spiceflow/react";
import type { App } from "../app.tsx";

const cliBannerCookieName = "sigillo-cli-banner-dismissed";
const cliBannerCodeLines = [
  [
    { text: "npm", kind: "command" },
    { text: " install -g ", kind: "plain" },
    { text: "sigillo", kind: "value" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " login", kind: "plain" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " run", kind: "plain" },
    { text: " -- ", kind: "operator" },
    { text: "next", kind: "command" },
    { text: " dev", kind: "plain" },
  ],
  [
    { text: "sigillo", kind: "value" },
    { text: " run --project ", kind: "plain" },
    { text: "website", kind: "value" },
    { text: " --env ", kind: "plain" },
    { text: "dev", kind: "value" },
    { text: " -- ", kind: "operator" },
    { text: "next", kind: "command" },
    { text: " dev", kind: "plain" },
  ],
] as const;

function CliBanner() {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <FramePanel className="relative overflow-hidden border-border/70 bg-muted/45 p-5">
      <button
        type="button"
        onClick={() => {
          document.cookie = `${cliBannerCookieName}=1; Path=/; Max-Age=31536000; SameSite=Lax`;
          setOpen(false);
        }}
        className="absolute right-0.5 top-0.5 z-10 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Dismiss CLI banner"
        title="Dismiss"
      >
        <XIcon className="size-4" />
      </button>

      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex flex-1 flex-col gap-1.5">
          <h2 className="text-base font-semibold tracking-tight">
            Use the Sigillo CLI
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Install with npm, then use <code className="font-mono text-foreground">sigillo run</code> to pass secrets to your process. Output is redacted by default.
          </p>
        </div>

        <pre className="cli-banner-code overflow-x-auto rounded-xl border border-border/70 bg-background/95 p-4 text-[12px]">
          <code className="block font-mono">
            {cliBannerCodeLines.map((line, i) => (
              <span key={i} className="flex gap-x-4 leading-6">
                <span className="w-5 shrink-0 select-none text-right text-muted-foreground/80">
                  {i + 1}
                </span>
                <span className="whitespace-pre">
                  {line.map((token, j) => (
                    <span key={j} className={`cli-token-${token.kind}`}>
                      {token.text}
                    </span>
                  ))}
                </span>
              </span>
            ))}
          </code>
        </pre>
      </div>
    </FramePanel>
  );
}

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
  showBanner,
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
  showBanner?: boolean;
}) {
  const router = getRouter<App>();
  const [allVisible, setAllVisible] = useState(false);

  return (
    <div className="flex flex-col gap-4 w-full">
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
            onValueChange={(val: string | null) => {
              if (!val) return
              router.push(router.href('/orgs/:orgId/projects/:projectId/envs/:envId', { orgId, projectId, envId: val }));
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

      {showBanner && <CliBanner />}

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
