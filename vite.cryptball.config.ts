import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/cryptball",
  base: process.env.CRYPTBALL_BASE_PATH ?? "/games/cryptball/",
  server: { host: "127.0.0.1", port: 4223, strictPort: true },
  build: {
    target: "es2022",
    outDir: "../../.local-game-tests/cryptball",
    emptyOutDir: true,
  },
});
