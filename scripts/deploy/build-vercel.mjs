import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { connectorHeaders } from "../../connector/worker.js";
import { productionConnectorConfig } from "./connector-release-config.mjs";

const service = process.env.MADHOUSE_SERVICE;
if (!["wiki", "connector"].includes(service))
  throw new Error("MADHOUSE_SERVICE must explicitly select wiki or connector");
const sourceCommit =
  process.env.VERCEL_GIT_COMMIT_SHA || process.env.MADHOUSE_RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(sourceCommit || ""))
  throw new Error("A verified source commit SHA is required");
const productionOrigin = (value) =>
  productionConnectorConfig({ origin: value, protocolVersion: 1 }, true).origin;
const wikiOrigin =
  service === "connector"
    ? productionOrigin(process.env.CONNECTOR_WIKI_ORIGIN)
    : null;
const connectorOrigin =
  service === "connector"
    ? productionOrigin(process.env.CONNECTOR_PUBLIC_ORIGIN)
    : productionOrigin(process.env.VITE_TELEGRAM_CONNECTOR_ORIGIN);
if (wikiOrigin === connectorOrigin)
  throw new Error("Wiki and connector must use separate origins");
const root = process.cwd();
const output = resolve(root, ".vercel/output");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
execFileSync(
  "npm",
  ["run", service === "connector" ? "build:connector" : "build:hosted"],
  { stdio: "inherit" },
);
const client = service === "connector" ? "connector/dist" : "dist";
cpSync(client, resolve(output, "static"), { recursive: true });
const marker =
  service === "connector"
    ? {
        service: "telegram-connector",
        sourceCommit,
        protocolVersion: 1,
        wikiOrigin,
        connectorOrigin,
        provider: "Vercel",
      }
    : {
        sourceRepository: "https://github.com/kotecccc/madhouse-wiki",
        sourceCommit,
        provider: "Vercel",
        catalogue: "reference-only-sqlite",
        telegramConnector: { origin: connectorOrigin, protocolVersion: 1 },
      };
if (service === "wiki") {
  const built = JSON.parse(
    readFileSync(resolve(output, "static/connection-config.json"), "utf8"),
  );
  if (productionConnectorConfig(built, true).origin !== connectorOrigin)
    throw new Error(
      "Built connector configuration does not match production origin",
    );
}
writeFileSync(resolve(output, "static/release.json"), JSON.stringify(marker));
function functionFiles(name, files, entry) {
  const dir = resolve(output, "functions", name + ".func");
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(resolve(dir, file)), { recursive: true });
    cpSync(resolve(root, file), resolve(dir, file));
  }
  writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(resolve(dir, "index.mjs"), entry);
  writeFileSync(
    resolve(dir, ".vc-config.json"),
    JSON.stringify({
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      maxDuration: 30,
    }),
  );
}
const routes = [];
const overrides = {};
if (service === "connector") {
  routes.push({
    src: "/(.*)",
    headers: connectorHeaders([wikiOrigin]),
    continue: true,
  });
  routes.push({
    src: "/(?!api/)(.*)",
    headers: { "Cache-Control": "no-cache" },
    continue: true,
  });
  routes.push({
    src: "/assets/(.*)",
    headers: { "Cache-Control": "public, max-age=31536000, immutable" },
    continue: true,
  });
  routes.push({
    src: "/api/(.*)",
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    },
    continue: true,
  });
  const files = [
    "scripts/deploy/vercel-connector-handler.mjs",
    "connector/game-auth-api.js",
    "connector/worker.js",
  ];
  for (const [name, endpoint] of [
    ["api/config", "/api/config"],
    ["api/game-session", "/api/game-session"],
    ["api/unknown", "/api/unknown"],
  ]) {
    functionFiles(
      name,
      files,
      `import {createVercelConnectorHandler} from './scripts/deploy/vercel-connector-handler.mjs';export default createVercelConnectorHandler(${JSON.stringify({ wikiOrigin, connectorOrigin, endpoint })});`,
    );
  }
  for (const file of readdirSync(resolve(output, "static/assets")))
    if (file.endsWith(".wasm"))
      overrides["assets/" + file] = { contentType: "application/wasm" };
  routes.push({ handle: "filesystem" });
  routes.push({ src: "/api/(.*)", dest: "/api/unknown" });
} else {
  functionFiles(
    "api",
    [
      "api/[...path].js",
      "scripts/deploy/production-api.mjs",
      "public/api-docs/openapi.readonly.json",
    ],
    "export {default} from './api/[...path].js';",
  );
  routes.push({ src: "/api/(.*)", dest: "/api" });
  routes.push({
    src: "/api-docs/?",
    status: 302,
    headers: { Location: "/api-docs/index.html" },
  });
  routes.push({ handle: "filesystem" });
  routes.push({
    src: "/(?!(?:api|api-docs|assets)/)([^.]*)",
    dest: "/index.html",
  });
}
writeFileSync(
  resolve(output, "config.json"),
  JSON.stringify({ version: 3, routes, overrides }, null, 2),
);
console.log("Vercel Build Output prepared", { service, sourceCommit });
