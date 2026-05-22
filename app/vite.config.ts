/// <reference types="vitest/config" />
// Read D1 migration SQL files so they can be applied in the workerd setup file
import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { holocron } from '@holocron.so/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spiceflowPlugin } from 'spiceflow/vite'
import { defineConfig } from 'vite'

const port = parseInt(process.env.PORT || '5188', 10)

export default defineConfig(async () => {
  const migrations = process.env.VITEST
    ? await readD1Migrations(path.join(__dirname, '../db/drizzle-app'))
    : []

  return {
    server: { port, strictPort: true },
    clearScreen: false,
    plugins: [
      // cloudflareTest() runs tests inside workerd via @cloudflare/vitest-pool-workers.
      // cloudflare() handles dev/build/deploy but conflicts with the vitest pool
      // (both manage workerd), so only one is active at a time.
      process.env.VITEST
        ? cloudflareTest({
            wrangler: { configPath: './wrangler.test.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
              },
            },
          })
        : null,
      // In test mode: use raw plugins (holocron auto-adds react+tailwind+spiceflow
      // which conflicts with cloudflareTest). In dev/build: use holocron.
      ...(process.env.VITEST
        ? [react(), spiceflowPlugin({ entry: './src/app.tsx' })]
        : [holocron({ entry: './src/app.tsx', pagesDir: './src/docs' })]),
      // cloudflare() must come AFTER spiceflow/holocron — spiceflow sets ssr outDir to
      // dist/rsc/ssr (nested inside the worker root) so workerd can resolve the
      // cross-environment import. cloudflare's config hook unconditionally sets
      // outDir to dist/ssr (sibling), and Vite's config merge gives the first
      // setter priority. See https://github.com/cloudflare/workers-sdk/issues/13869
      !process.env.VITEST
        ? cloudflare({
            viteEnvironment: {
              name: 'rsc',
              childEnvironments: ['ssr'],
            },
          })
        : null,
    ],
    resolve: {
      dedupe: ['spiceflow', 'spiceflow/react', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
    test: {
      setupFiles: ['./src/test-setup.ts'],
    },
  }
})
