import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const output = resolve(root, "apps/cryptball/build-identity.ts");
const sources = new Map();
async function resolveSource(candidate) {
  const candidates = /\.[cm]?tsx?$/.test(candidate)
    ? [candidate]
    : [`${candidate}.ts`, `${candidate}.tsx`, resolve(candidate, "index.ts"), resolve(candidate, "index.tsx")];
  for (const path of candidates) {
    try { await access(path); return path; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  throw Error(`Cannot resolve authority source: ${relative(root, candidate)}`);
}
async function visit(path) {
  if (path === output || sources.has(path)) return;
  const source = await readFile(path, "utf8");
  sources.set(path, source);
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith(".")) {
      const candidate = resolve(dirname(path), specifier);
      await visit(await resolveSource(candidate));
    } else if (specifier.startsWith("@onepage/")) {
      await visit(require.resolve(specifier));
    }
  }
}
await visit(resolve(root, "apps/cryptball/sim/session.ts"));
await visit(resolve(root, "apps/cryptball/protocol.ts"));
await visit(resolve(root, "apps/cryptball/friends-protocol.ts"));
const hash = createHash("sha256");
for (const [path, source] of [...sources].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  hash.update(relative(root, path)); hash.update("\0"); hash.update(source); hash.update("\0");
}
const identity = `cryptball-v1-${hash.digest("hex").slice(0, 24)}`;
const generated = `// Generated from game authority, protocol, and transitive engine sources.\nexport const BUILD = ${JSON.stringify(identity)};\n`;
let previous = "";
try { previous = await readFile(output, "utf8"); } catch {}
if (previous !== generated) await writeFile(output, generated);
console.log(`Cryptball authority: ${identity} (${sources.size} source files)`);
