/// <reference types="vitest/config" />
import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

const port = parseInt(process.env.PORT || '5188', 10)

export default defineConfig(async () => {
  // Read D1 migration SQL files so they can be applied in the workerd setup file
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
        : cloudflare({
            viteEnvironment: {
              name: 'rsc',
              childEnvironments: ['ssr'],
            },
          }),
      react(),
      spiceflowPlugin({ entry: './src/app.tsx' }),
      ...(process.env.VITEST ? [] : [tailwindcss()]),
    ],
    test: {
      setupFiles: ['./src/test-setup.ts'],
    },
  }
})
