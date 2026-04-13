// Typed helper to get the SecretsStore DO stub.
// wrangler types generates DurableObjectNamespace without the generic,
// so we cast the stub to get RPC methods.

import { env } from 'cloudflare:workers'
import type { SecretsStore } from './secrets-store.ts'

export function getSecretsStoreStub() {
  const id = env.SECRETS_STORE.idFromName('main')
  return env.SECRETS_STORE.get(id) as DurableObjectStub<SecretsStore>
}
