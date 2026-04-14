// Client component form for creating a new organization.
// Uses server action, navigates on success.

"use client";

import { useState } from "react";
import { getRouter } from "spiceflow/react";
import { Button } from "sigillo-app/src/components/ui/button";
import { createOrgAction } from "../actions.ts";
import type { App } from "../app.tsx";

export function CreateOrgForm() {
  const router = getRouter<App>();
  const [message, setMessage] = useState("");

  return (
    <form
      className="flex flex-col gap-4"
      action={async (formData: FormData) => {
        const result = await createOrgAction("", formData);
        if (result.startsWith("Created:")) {
          const orgId = result.split(":")[1];
          router.push(`/orgs/${orgId}`);
        } else {
          setMessage(result);
        }
      }}
    >
      <div>
        <label htmlFor="org-name" className="text-sm font-medium mb-1.5 block">Name</label>
        <input
          id="org-name"
          name="name"
          placeholder="My Organization"
          required
          autoFocus
          className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      {message && <p className="text-xs text-destructive">{message}</p>}
      <Button type="submit">Create Organization</Button>
    </form>
  );
}
