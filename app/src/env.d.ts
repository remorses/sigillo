// Augment the wrangler-generated Env to parameterize DO namespaces.
// wrangler types generates DurableObjectNamespace without the generic,
// so RPC methods are not visible on the stub. This fixes that.

import type { SecretsStore } from './secrets-store.ts'

declare global {
  interface Env {
    SECRETS_STORE: DurableObjectNamespace<SecretsStore>
  }
}
