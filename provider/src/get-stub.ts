// Typed helper to get the AuthStore DO stub.
// wrangler types generates DurableObjectNamespace without the generic,
// so we cast the stub to get RPC methods.

import { env } from 'cloudflare:workers'
import type { AuthStore } from './auth-store.ts'

export function getAuthStoreStub() {
  const id = env.AUTH_STORE.idFromName('main')
  return env.AUTH_STORE.get(id) as DurableObjectStub<AuthStore>
}
