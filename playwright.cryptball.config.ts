import { defineConfig } from "@playwright/test";
// Native ANGLE avoids software-renderer frame-debt pauses on macOS. Linux CI
// retains the software backend; explicit overrides remain available for QA.
const angle = process.env.CRYPTBALL_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader");
export default defineConfig({
  testDir: "apps/cryptball/tests",
  testMatch: ["smoke.spec.ts", "sports-smoke.spec.ts", "special-input.spec.ts", "controls.spec.ts", "menu-layout.spec.ts", "new-modes.spec.ts"],
  outputDir: ".local-game-tests/cryptball-browser",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4223",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ["--use-gl=angle", `--use-angle=${angle}`, "--enable-webgl"],
    },
  },
  webServer: {
    command:
      "npm run build:cryptball && npx vite preview --config vite.cryptball.config.ts --host 127.0.0.1 --port 4223 --strictPort",
    url: "http://127.0.0.1:4223/games/cryptball/",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
