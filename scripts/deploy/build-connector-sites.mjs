import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { build } from "esbuild";
import { VERSION } from "../../connector/protocol.js";

const root = process.cwd();
const output = resolve(root, ".sites-release/connector");
const wiki = new URL(
  process.env.CONNECTOR_WIKI_ORIGIN ||
    "https://madhouse-wiki.damir-tarasov2016.chatgpt.site",
);
if (
  wiki.protocol !== "https:" ||
  wiki.pathname !== "/" ||
  wiki.search ||
  wiki.hash ||
  wiki.username ||
  wiki.password
)
  throw new Error("Invalid Wiki origin");
const assets = {};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const dist = resolve(root, "connector/dist");
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await collect(file);
    else
      assets["/" + relative(dist, file)] = {
        type: mime[extname(file)] || "application/octet-stream",
        body: (await readFile(file)).toString("base64"),
      };
  }
}
await collect(dist);
const sourceCommit = process.env.MADHOUSE_RELEASE_SHA || "local";
if (sourceCommit !== "local" && !/^[a-f0-9]{40}$/.test(sourceCommit))
  throw new Error("Invalid release source commit");
assets["/release.json"] = {
  type: "application/json; charset=utf-8",
  body: Buffer.from(
    JSON.stringify({
      service: "telegram-connector",
      sourceCommit,
      protocolVersion: VERSION,
      wikiOrigin: wiki.origin,
    }),
  ).toString("base64"),
};
await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "server"), { recursive: true });
await build({
  stdin: {
    contents: `import {createConnectorWorker} from './connector/worker.js';export default createConnectorWorker(${JSON.stringify(assets)},${JSON.stringify([wiki.origin])});`,
    resolveDir: root,
  },
  outfile: resolve(output, "server/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
});
await writeFile(
  resolve(output, "build-info.json"),
  JSON.stringify(
    {
      kind: "isolated-telegram-connector",
      wikiOrigin: wiki.origin,
      files: Object.keys(assets).length,
      credentialsIncluded: false,
    },
    null,
    2,
  ),
);
// The owning publisher must supply the second Site's real hosting identity.
// This script never copies the Wiki Site project_id or any runtime parameters.
console.log(
  "Isolated connector Worker packaged without application parameters",
  output,
);
