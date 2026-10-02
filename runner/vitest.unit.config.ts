// Unit-only config: everything in tests/unit/** is pure logic (stubbed
// login, no network, no browser — see tests/unit/*.test.ts). It deliberately
// does NOT set vitest.config.ts's globalSetup (prewarmLogin hits the real
// staging BFF) or setupFiles (loadEnv() requires STAGING_BASE_URL etc. to be
// configured) — those belong only to the real e2e run against staging.
//
// This is a standalone config rather than a vitest/config mergeConfig() of
// vitest.config.ts on purpose: mergeConfig concatenates array-valued options
// (globalSetup, include, ...) instead of replacing them, so
// `globalSetup: []` merged against the base's `globalSetup: ["./global-
// setup.ts"]` silently stays ["./global-setup.ts"] — which defeats the
// entire point of this file (confirmed: that's exactly what happened when
// this was first written as a mergeConfig).
//
// Run with: pnpm --filter @revhero/qa-runner test:unit
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    isolate: true,
    retry: 0,
    reporters: ["default"],
    globals: false
  },
  resolve: {
    alias: {
      "@revhero/qa-shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@fixtures": path.resolve(__dirname, "fixtures"),
      "@lib": path.resolve(__dirname, "lib")
    }
  }
});
