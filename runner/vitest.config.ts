import { defineConfig } from "vitest/config";
import path from "node:path";

const tagFilter = process.env.QA_TAG_FILTER;

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    maxConcurrency: 4,
    fileParallelism: true,
    isolate: true,
    retry: 0,
    reporters: ["default"],
    setupFiles: ["./fixtures/setup.ts"],
    globals: false,
    sequence: {
      concurrent: false
    },
    server: {
      deps: {
        inline: ["@revhero/qa-shared"]
      }
    }
  },
  resolve: {
    alias: {
      "@revhero/qa-shared": path.resolve(__dirname, "../shared/src/index.ts"),
      "@fixtures": path.resolve(__dirname, "fixtures"),
      "@lib": path.resolve(__dirname, "lib")
    }
  },
  define: {
    "import.meta.vitest_tag_filter": JSON.stringify(tagFilter ?? "")
  }
});
