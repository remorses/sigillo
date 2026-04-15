// Reusable Input and Textarea components with consistent styling.
// Consolidates the repeated border/focus/ring patterns used across
// secrets-table, environments-table, sidebar, and create-org-form.

import type * as React from "react";
import { cn } from "sigillo-app/src/lib/utils";

export function Input({
  className,
  inputSize = "default",
  ...props
}: Omit<React.ComponentProps<"input">, "size"> & { inputSize?: "default" | "sm"; size?: never }): React.ReactElement {
  return (
    <input
      className={cn(
        "rounded-md border border-input bg-background text-sm focus:outline-none focus:ring-1 focus:ring-ring",
        inputSize === "sm" ? "h-7 px-2" : "h-9 px-3",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">): React.ReactElement {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring resize-y",
        className,
      )}
      {...props}
    />
  );
}
