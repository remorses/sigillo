// Client-side redirect component for use in page handlers.
// Page handlers can't return Response.redirect() because Response objects
// get serialized as RSC props and blow up. This component does the
// redirect on the client via router.replace().
//
// Used by the /orgs/:orgId page handler: when an org has projects, the
// .get() handler should redirect via HTTP 302, but in dev mode this can
// fail. This component acts as a fallback to ensure the redirect happens.

"use client";

import { useEffect } from "react";
import { getRouter } from "spiceflow/react";
import type { App } from "../app.tsx";

export function ClientRedirect({ to }: { to: string }) {
  const router = getRouter<App>();
  useEffect(() => {
    router.replace(to);
  }, [to]);
  return null;
}
