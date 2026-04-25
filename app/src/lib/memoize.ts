// Memoize async functions via Cloudflare Cache API (caches.default).
// Cache keys include the deployment id so stale entries are never served across deploys.
// Requires a custom domain; does NOT work on *.workers.dev.
//
// Supports stale-while-revalidate (SWR): within the SWR window, stale values
// are returned immediately while a background refresh runs via waitUntil().
// The Cache API itself doesn't support SWR, so we store createdAt alongside
// the value and check age ourselves. s-maxage is set to ttl + swr so the
// Cache API keeps the entry alive for the full window.
//
// IMPORTANT: null, undefined, and Error results are NEVER cached. This prevents
// caching "not found" or "unauthorized" responses that would lock users out
// until the TTL expires. Memoized functions that indicate absence or failure
// MUST return null/undefined or throw. Never return a truthy sentinel for
// missing data, or it will be cached and served for the full TTL window.

import superjson from 'superjson'
import { waitUntil } from 'cloudflare:workers'
import { getDeploymentId } from 'spiceflow'

const CACHE_BASE = 'https://worker-memoize.internal/'

interface CacheEnvelope<T> {
  value: T
  createdAt: number
}

export interface MemoizeOptions<Args extends unknown[], T> {
  namespace: string
  fn: (...args: Args) => Promise<T>
  /** Fresh window in seconds. Default: 300 (5 min) */
  ttl?: number
  /** Stale-while-revalidate window in seconds. Default: 600 (10 min) */
  swr?: number
}

function shouldCache<T>(value: T): boolean {
  if (value == null) return false
  if (value instanceof Error) return false
  return true
}

export function memoize<Args extends unknown[], T>(
  options: MemoizeOptions<Args, T>,
): (...args: Args) => Promise<T> {
  const { namespace, fn, ttl = 300, swr = 600 } = options

  return async (...args: Args): Promise<T> => {
    const cache = (caches as any).default as Cache
    const key = await buildCacheKey(namespace, args)
    const req = new Request(key)

    const hit = await cache.match(req)
    if (hit) {
      const envelope = superjson.parse(await hit.text()) as CacheEnvelope<T>
      const age = (Date.now() - envelope.createdAt) / 1000

      if (age < ttl) {
        return envelope.value
      }

      if (swr > 0 && age < ttl + swr) {
        waitUntil(refreshCache(cache, req, fn, args, ttl + swr))
        return envelope.value
      }
    }

    const value = await fn(...args)
    if (shouldCache(value)) {
      waitUntil(putCache(cache, req, value, ttl + swr))
    }
    return value
  }
}

async function refreshCache<Args extends unknown[], T>(
  cache: Cache,
  req: Request,
  fn: (...args: Args) => Promise<T>,
  args: Args,
  maxAge: number,
): Promise<void> {
  const value = await fn(...args)
  if (shouldCache(value)) {
    await putCache(cache, req, value, maxAge)
  } else {
    // Value became null/error; evict stale entry so next request hits DB
    await cache.delete(req)
  }
}

async function putCache<T>(
  cache: Cache,
  req: Request,
  value: T,
  maxAge: number,
): Promise<void> {
  const envelope: CacheEnvelope<T> = { value, createdAt: Date.now() }
  const response = new Response(superjson.stringify(envelope), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `s-maxage=${maxAge}`,
    },
  })
  await cache.put(req, response)
}

export async function invalidate(namespace: string, ...args: unknown[]): Promise<boolean> {
  const cache = (caches as any).default as Cache
  const key = await buildCacheKey(namespace, args)
  return cache.delete(new Request(key))
}

async function buildCacheKey(namespace: string, args: unknown[]): Promise<string> {
  const id = await getDeploymentId()
  const prefix = id ? `${CACHE_BASE}${id}/` : CACHE_BASE
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
