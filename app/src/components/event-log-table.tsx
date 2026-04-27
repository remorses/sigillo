// Event log table — shows the append-only secretEvent audit trail.
// Env select filters events. Eye icon toggles value visibility (set events only).
// Badges: green for "set", red for "delete".

"use client";

import { ClockIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { cn } from "sigillo-app/src/lib/utils";
import { EmptyState } from "sigillo-app/src/components/ui/empty-state";
import { useState } from "react";
import { router, useLoaderData } from "spiceflow/react";
import { Badge } from "sigillo-app/src/components/ui/badge";
import { Frame } from "sigillo-app/src/components/ui/frame";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "sigillo-app/src/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "sigillo-app/src/components/ui/table";
import { formatTime } from "sigillo-app/src/lib/utils";

// Secret values use the .text-security-disc CSS class from globals.css.

export function EventLogTable() {
  const {
    projectName,
    events,
    environments,
    selectedEnvId,
    orgId,
    projectId,
  } = useLoaderData('/orgs/:orgId/projects/:projectId/envs/:envSlug/event-log');
  const [visibleValues, setVisibleValues] = useState<Record<string, boolean>>({});

  const toggleValue = (id: string) => {
    setVisibleValues((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">{projectName}</h1>
        <Select
          defaultValue={selectedEnvId || ""}
          onValueChange={(val: string | null) => {
            if (!val) return
            const env = environments.find((e) => e.id === val);
            if (env) router.push(router.href('/orgs/:orgId/projects/:projectId/envs/:envSlug/event-log', { orgId, projectId, envSlug: env.slug }));
          }}
        >
          <SelectTrigger size="sm" className="w-auto min-w-40">
            <SelectValue placeholder="All environments">
              {environments.find((e) => e.id === selectedEnvId)?.name || "All environments"}
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

      {events.length === 0 ? (
        <EmptyState
          icon={<ClockIcon className="size-6 text-muted-foreground" />}
          title="No events yet"
          description="Secret changes will appear here as an audit trail."
        />
      ) : (
        <Frame className="w-full">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-40" />
              <col className="w-24" />
              <col style={{ width: "300px" }} />
              <col className="w-36" />
              <col className="w-24" />
            </colgroup>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Secret</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>User</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((evt) => {
                const isVisible = visibleValues[evt.id] ?? false;
                const hasValue = evt.operation === "set" && evt.value != null;
                return (
                  <TableRow key={evt.id}>
                    <TableCell>
                      <span className="text-sm font-mono font-medium">{evt.name}</span>
                    </TableCell>
                    <TableCell>
                      {evt.operation === "set" ? (
                        <Badge variant="default" size="sm" className="bg-emerald-600 text-white">
                          set
                        </Badge>
                      ) : (
                        <Badge variant="destructive" size="sm">
                          delete
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {hasValue ? (
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "text-sm font-mono truncate min-w-0 flex-1",
                              !isVisible && "text-security-disc",
                            )}
                          >
                            {isVisible ? evt.value : "••••••••••••"}
                          </span>
                          <button
                            onClick={() => toggleValue(evt.id)}
                            className="text-muted-foreground hover:text-foreground cursor-pointer shrink-0"
                            title={isVisible ? "Hide value" : "Reveal value"}
                          >
                            {isVisible ? (
                              <EyeOffIcon className="size-3.5" />
                            ) : (
                              <EyeIcon className="size-3.5" />
                            )}
                          </button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {formatTime(evt.createdAt)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground truncate">{evt.userName}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Frame>
      )}
    </>
  );
}
