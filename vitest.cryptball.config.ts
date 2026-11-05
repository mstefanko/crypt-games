import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/cryptball/tests/**/*.test.ts", "packages/game-runtime/src/runtime.test.ts"],
    exclude: [
      "apps/cryptball/tests/online*.test.ts",
      "apps/cryptball/tests/full-match-authority.test.ts",
    ],
    environment: "node",
    maxWorkers: 2,
  },
});
