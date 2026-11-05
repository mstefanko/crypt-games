import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./build.mjs";
const cwd = fileURLToPath(new URL("../../", import.meta.url));
const children = [
  spawn(process.execPath, ["dist/cryptball-server/main.mjs"], {
    cwd,
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "vite.cryptball.config.ts"],
    { cwd, stdio: "inherit" },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 1500);
}
for (const child of children) {
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
