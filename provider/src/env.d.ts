// Augment the wrangler-generated Env to parameterize DO namespaces.
// wrangler types generates DurableObjectNamespace without the generic,
// so RPC methods are not visible on the stub. This fixes that.

import type { AuthStore } from './auth-store.ts'

declare global {
  interface Env {
    AUTH_STORE: DurableObjectNamespace<AuthStore>
  }
}
