// Native select wrapper that matches the shared select trigger styling.

"use client";

import { ChevronsUpDownIcon } from "lucide-react";
import type * as React from "react";
import { cva } from "class-variance-authority";
import { cn } from "sigillo-app/src/lib/utils";

const nativeSelectVariants = cva(
  "relative inline-flex min-h-9 w-full min-w-36 items-center rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] pr-8 text-left text-base text-foreground shadow-xs/5 outline-none ring-ring/24 transition-shadow focus-visible:border-ring focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-64 sm:min-h-8 sm:text-sm dark:bg-input/32",
)

export function NativeSelect({
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return (
    <div className="relative w-full">
      <select
        className={cn(nativeSelectVariants(), "appearance-none rounded-md", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronsUpDownIcon className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 opacity-80 sm:size-4" />
    </div>
  );
}
