import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  out: './drizzle-provider',
  schema: './src/provider-schema.ts',
  dialect: 'sqlite',
  driver: 'durable-sqlite',
})
