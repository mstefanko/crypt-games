import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
function clientRevision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    return revision + (dirty ? "-dirty" : "");
  } catch { return "unknown"; }
}
export default defineConfig({
  define: { "import.meta.env.VITE_CRYPTBALL_REVISION": JSON.stringify(clientRevision()) },
  root: "apps/cryptball",
  base: process.env.CRYPTBALL_BASE_PATH ?? "/games/cryptball/",
  server: { host: "127.0.0.1", port: 4223, strictPort: true },
  build: {
    target: "es2022",
    outDir: "../../.local-game-tests/cryptball",
    emptyOutDir: true,
  },
});
