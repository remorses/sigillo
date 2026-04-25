// Memoize async functions via Cloudflare Cache API (caches.default).
// Cache keys include the deployment id so stale entries are never served across deploys.
// Requires a custom domain; does NOT work on *.workers.dev.

import superjson from 'superjson'
import { waitUntil } from 'cloudflare:workers'
import { getDeploymentId } from 'spiceflow'

const CACHE_BASE = 'https://worker-memoize.internal/'

let deploymentPrefix: Promise<string> | undefined

export interface MemoizeOptions<Args extends unknown[], T> {
  namespace: string
  fn: (...args: Args) => Promise<T>
  /** Seconds. Default: 60 */
  ttl?: number
}

export function memoize<Args extends unknown[], T>(
  options: MemoizeOptions<Args, T>,
): (...args: Args) => Promise<T> {
  const { namespace, fn, ttl = 60 } = options

  return async (...args: Args): Promise<T> => {
    const cache = caches.default
    const key = await buildCacheKey(namespace, args)
    const req = new Request(key)

    const hit = await cache.match(req)
    if (hit) {
      return superjson.parse(await hit.text()) as T
    }

    const value = await fn(...args)

    const response = new Response(superjson.stringify(value), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `s-maxage=${ttl}`,
      },
    })
    waitUntil(cache.put(req, response))

    return value
  }
}

export async function invalidate(namespace: string, ...args: unknown[]): Promise<boolean> {
  const cache = caches.default
  const key = await buildCacheKey(namespace, args)
  return cache.delete(new Request(key))
}

async function resolvePrefix(): Promise<string> {
  const id = await getDeploymentId()
  return id ? `${CACHE_BASE}${id}/` : CACHE_BASE
}

async function buildCacheKey(namespace: string, args: unknown[]): Promise<string> {
  if (!deploymentPrefix) deploymentPrefix = resolvePrefix()
  const prefix = await deploymentPrefix
  const serialized = superjson.stringify(args)
  const hash = await sha256(serialized)
  return `${prefix}${namespace}/${hash}`
}

async function sha256(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
