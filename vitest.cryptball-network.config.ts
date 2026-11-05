import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "apps/cryptball/tests/online*.test.ts",
      "apps/cryptball/tests/full-match-authority.test.ts",
    ],
    exclude: process.env.CRYPTBALL_BENCHMARK === "1" ? [] : ["apps/cryptball/tests/online-benchmark.test.ts"],
    environment: "node",
    // Maximum-speed authority replay must not compete with real-time socket clocks.
    fileParallelism: false,
    maxWorkers: 2,
  },
});
