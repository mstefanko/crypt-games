import "./identity.mjs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["apps/cryptball-server/src/main.ts"],
  outfile: "dist/cryptball-server/main.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["@colyseus/*", "msgpackr", "ws"],
  sourcemap: true,
});
