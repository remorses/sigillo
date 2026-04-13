import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

export default defineConfig({
  plugins: [
    react(),
    spiceflowPlugin({ entry: './src/app.tsx' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
