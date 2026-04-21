// Centered empty state with icon, heading, description, and optional actions.
// Used across secrets table, tokens page, and event log when there's no data.

import type * as React from "react";
import { cn } from "sigillo-app/src/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-16 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted mb-4">
        {icon}
      </div>
      <h3 className="text-base font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground mb-6 max-w-xs">
        {description}
      </p>
      {children}
    </div>
  );
}
