import { defineConfig } from "@playwright/test";
const angle = process.env.CRYPTBALL_ANGLE ?? (process.platform === "darwin" ? "metal" : "swiftshader");
export default defineConfig({
  testDir: "apps/cryptball/tests",
  testMatch: ["online.spec.ts", "menu-online.spec.ts"],
  outputDir: ".local-game-tests/cryptball-online-browser",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: "http://127.0.0.1:4226",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-gl=angle", `--use-angle=${angle}`, "--enable-webgl"],
    },
  },
  webServer: [
    {
      command:
        "npm run build:cryptball:server && node dist/cryptball-server/main.mjs",
      env: { PORT: "2568", CRYPTBALL_ORIGINS: "http://127.0.0.1:4226" },
      url: "http://127.0.0.1:2568/healthz",
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command:
        "npm run build:cryptball && npx vite preview --config vite.cryptball.config.ts --host 127.0.0.1 --port 4226 --strictPort",
      env: { VITE_CRYPTBALL_SERVER: "ws://127.0.0.1:2568" },
      url: "http://127.0.0.1:4226/games/cryptball/",
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
