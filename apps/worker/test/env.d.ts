declare namespace Cloudflare {
  interface Env {
    /** Migraciones de D1 leídas en vitest.config.ts. */
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
