import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "../../wrangler.toml" },
        miniflare: {
          compatibilityDate: "2024-01-01",
          compatibilityFlags: ["nodejs_compat"],
          bindings: {
            // Force WORKER_TYPE for testing AI Gateway
            WORKER_TYPE: "AI_GATEWAY_API",
            HELICONE_ORG_ID: "helicone-org-id",
          },
          kvNamespaces: ["CACHE_KV", "SECURE_CACHE", "EU_SECURE_CACHE", "RATE_LIMIT_KV", "INSERT_KV", "UTILITY_KV", "REQUEST_AND_RESPONSE_QUEUE_KV"],
          durableObjects: {
            WALLET: "Wallet",
          },
        },
      },
    },
    setupFiles: ["./../setup.ts"],
  },
  resolve: {
    alias: {
      "@helicone-package/cost": new URL(
        "../../../packages/cost",
        import.meta.url
      ).pathname,
      "@helicone-package/secrets": new URL(
        "../../../packages/secrets",
        import.meta.url
      ).pathname,
      "@worker": new URL("../../src", import.meta.url).pathname,
    },
  },
});
