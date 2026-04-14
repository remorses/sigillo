import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

export default defineConfig({
  resolve: {
    // TODO: remove this once Cloudflare dev stops realpathing linked package entries
    // outside the app. This is only needed for linked deps in local Cloudflare dev.
    preserveSymlinks: true,
  },
  plugins: [
    react(),
    spiceflowPlugin({ entry: './src/app.tsx' }),
    tailwindcss(),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
