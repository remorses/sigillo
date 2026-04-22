// Generate the OpenAPI spec from the API routes and write it to src/openapi.json.
// Run: pnpm openapi
//
// Can't import api.ts directly because it transitively pulls in cloudflare:workers.
// Instead, start the vite dev server briefly and fetch the spec from it.

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const vite = await createServer({ server: { port: 15188, strictPort: false } })
const server = await vite.listen()
const address = server.httpServer?.address()
const port = typeof address === 'object' && address ? address.port : 15188
const url = `http://localhost:${port}/api/v0/openapi.json`

try {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const spec = await res.json()
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), 'openapi.json')
  writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n')
  console.log(`Wrote ${outPath}`)
} finally {
  await vite.close()
  process.exit(0)
}
