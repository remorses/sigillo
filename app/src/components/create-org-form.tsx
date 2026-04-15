// Client component form for creating a new organization.
// Uses server action, navigates on success.

"use client";

import { getRouter } from "spiceflow/react";
import { ErrorBoundary } from "spiceflow/react";
import { Button } from "sigillo-app/src/components/ui/button";
import { Input } from "sigillo-app/src/components/ui/input";
import { createOrgAction } from "../actions.ts";
import type { App } from "../app.tsx";

export function CreateOrgForm() {
  const router = getRouter<App>();

  return (
    <ErrorBoundary
      fallback={
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 flex flex-col gap-2">
          <ErrorBoundary.ErrorMessage className="text-sm text-destructive" />
          <ErrorBoundary.ResetButton className="text-sm text-destructive underline cursor-pointer self-start">
            Try again
          </ErrorBoundary.ResetButton>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        action={async (formData: FormData) => {
          const name = formData.get("name") as string;
          const result = await createOrgAction({ name });
          router.push(router.href('/orgs/:orgId', { orgId: result.id }));
        }}
      >
        <div>
          <label htmlFor="org-name" className="text-sm font-medium mb-1.5 block">Name</label>
          <Input
            id="org-name"
            name="name"
            placeholder="My Organization"
            required
            autoFocus
            className="w-full"
          />
        </div>
        <Button type="submit">Create Organization</Button>
      </form>
    </ErrorBoundary>
  );
}
