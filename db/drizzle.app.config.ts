import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle-app',
  schema: './src/app-schema.ts',
  dialect: 'sqlite',
})
