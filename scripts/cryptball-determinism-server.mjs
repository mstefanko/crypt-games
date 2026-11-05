import { build } from "esbuild";
import { createServer } from "node:http";
const result = await build({
  entryPoints: ["apps/cryptball/tests/determinism/run.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
const javascript =
  result.outputFiles[0].text +
  "\nwindow.runDeterminism = runDeterminism; window.runReplayProfile = runReplayProfile; window.runSportsDeterminism = runSportsDeterminism; window.runSportsReplayProfile = runSportsReplayProfile;";
createServer((request, response) => {
  if (request.url === "/run.js") {
    response.setHeader("content-type", "text/javascript");
    response.end(javascript);
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      '<!doctype html><title>Cryptball frozen determinism fixture</title><script type="module" src="/run.js"></script>',
    );
  }
}).listen(4225, "127.0.0.1");
