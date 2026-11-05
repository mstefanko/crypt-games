import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "apps/cryptball/tests",
  testMatch: "determinism.spec.ts",
  outputDir: ".local-game-tests/cryptball-determinism",
  workers: 1,
  timeout: 120000,
  use: { baseURL: "http://127.0.0.1:4225", headless: true },
  projects: ["chromium", "webkit", "firefox"].map((browserName) => ({
    name: browserName,
    use: { browserName: browserName as "chromium" | "webkit" | "firefox" },
  })),
  webServer: {
    command: "node scripts/cryptball-determinism-server.mjs",
    url: "http://127.0.0.1:4225/games/cryptball/tests/determinism/",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
