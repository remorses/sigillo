// Type augmentation for the test-only TEST_MIGRATIONS binding injected via
// miniflare config in vite.config.ts.

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: D1Migration[]
  }
}

interface D1Migration {
  name: string
  queries: string[]
}

// nodejs_compat exposes process.env at runtime in Cloudflare Workers.
// Only the subset we actually use is declared to avoid pulling in @types/node.
declare var process: { env: Record<string, string | undefined> }
