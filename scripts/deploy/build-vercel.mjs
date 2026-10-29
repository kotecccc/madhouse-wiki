import { buildSync } from "esbuild";
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
import { VERSION } from "../../connector/protocol.js";
import { packageSeed } from "../catalogue/package-seed.mjs";
import { productionConnectorConfig } from "./connector-release-config.mjs";

const service = process.env.MADHOUSE_SERVICE;
if (!["wiki", "connector"].includes(service))
  throw new Error("MADHOUSE_SERVICE must explicitly select wiki or connector");
const sourceCommit =
  process.env.VERCEL_GIT_COMMIT_SHA || process.env.MADHOUSE_RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(sourceCommit || ""))
  throw new Error("A verified source commit SHA is required");
const publicHttpsOrigin = (value, name) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS origin`);
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(`${name} must be an HTTPS origin`);
  return url.origin;
};
const productionOrigin = (value) =>
  productionConnectorConfig({ origin: value, protocolVersion: VERSION }, true)
    .origin;
const wikiOrigin =
  service === "connector"
    ? productionOrigin(process.env.CONNECTOR_WIKI_ORIGIN)
    : publicHttpsOrigin(
        process.env.WIKI_PUBLIC_ORIGIN || "https://madhouse-wiki.ru",
        "WIKI_PUBLIC_ORIGIN",
      );
const connectorOrigin =
  service === "connector"
    ? productionOrigin(process.env.CONNECTOR_PUBLIC_ORIGIN)
    : productionOrigin(process.env.VITE_TELEGRAM_CONNECTOR_ORIGIN);
const wikiOrigins =
  service === "connector"
    ? [
        ...new Set([
          wikiOrigin,
          ...(process.env.CONNECTOR_LEGACY_WIKI_ORIGINS || "")
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean)
            .map(productionOrigin),
        ]),
      ]
    : [wikiOrigin];
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
        protocolVersion: VERSION,
        wikiOrigin,
        connectorOrigin,
        provider: "Vercel",
      }
    : {
        sourceRepository: "https://github.com/kotecccc/madhouse-wiki",
        sourceCommit,
        provider: "Vercel",
        catalogue: "reference-only-sqlite",
        telegramConnector: {
          origin: connectorOrigin,
          protocolVersion: VERSION,
        },
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
function functionFiles(
  name,
  files,
  entry,
  bundle = service === "connector",
  maxDuration = 30,
) {
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
  if (bundle)
    buildSync({
      stdin: {
        contents: entry,
        resolveDir: dir,
        sourcefile: "connector-entry.mjs",
      },
      outfile: resolve(dir, "index.mjs"),
      bundle: true,
      platform: "node",
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      format: "esm",
      target: "node24",
      nodePaths: [resolve(root, "node_modules")],
    });
  else writeFileSync(resolve(dir, "index.mjs"), entry);
  writeFileSync(
    resolve(dir, ".vc-config.json"),
    JSON.stringify({
      runtime: "nodejs24.x",
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      maxDuration,
    }),
  );
}
const routes = [];
const overrides = {};
if (service === "connector") {
  routes.push({
    src: "/(.*)",
    headers: connectorHeaders(wikiOrigins),
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
    "connector/account-session.js",
    "connector/blob-session-store.js",
    "shared/wiki-session.js",
    "scripts/storage/client.mjs",
  ];
  for (const [name, endpoint] of [
    ["api/config", "/api/config"],
    ["api/game-session", "/api/game-session"],
    ["api/account-session", "/api/account-session"],
    ["api/unknown", "/api/unknown"],
  ]) {
    functionFiles(
      name,
      files,
      `import {createVercelConnectorHandler} from './scripts/deploy/vercel-connector-handler.mjs';export default createVercelConnectorHandler(${JSON.stringify({ wikiOrigin, wikiOrigins, connectorOrigin, endpoint })});`,
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
      "shared/wiki-session.js",
      "scripts/api-operations.mjs",
      "scripts/deploy/production-api.mjs",
      "public/api-docs/openapi.json",
    ],
    "export {default} from './api/[...path].js';",
  );
  const raidsFiles = [
    "api/raids.js",
    "scripts/telegram/raid-api.mjs",
    "scripts/telegram/raid-feed-page.mjs",
    "scripts/telegram/raid-blob-store.mjs",
    "scripts/storage/client.mjs",
    "scripts/telegram/raid-blob-etag.mjs",
    "scripts/telegram/raid-vercel-handler.mjs",
  ];
  functionFiles(
    "api/raids",
    raidsFiles,
    "export {default} from './api/raids.js';",
    true,
  );
  const raidsSyncFiles = [
    "api/telegram/raids-sync.js",
    "scripts/telegram/raid-sync-api.mjs",
    "scripts/telegram/raid-synchronizer.mjs",
    "scripts/telegram/raid-history-sync.mjs",
    "scripts/telegram/raid-blob-etag.mjs",
    "scripts/telegram/raid-sync-lock.mjs",
    "scripts/telegram/raid-session-store.mjs",
    "scripts/telegram/raid-mtproto-client.mjs",
    "scripts/telegram/raid-blob-store.mjs",
    "scripts/storage/client.mjs",
    "scripts/telegram/raid-schedule-parser.mjs",
    "scripts/telegram/raid-vercel-handler.mjs",
    "node_modules/@mtcute/wasm/mtcute-simd.wasm",
    "node_modules/@mtcute/wasm/mtcute.wasm",
  ];
  functionFiles(
    "api/telegram/raids-sync",
    raidsSyncFiles,
    "export {default} from './api/telegram/raids-sync.js';",
    true,
    60,
  );
  const wikiBotFiles = [
    "api/telegram/bot-webhook.js",
    "scripts/telegram/wiki-bot.mjs",
    "scripts/telegram/inline-card-assets.mjs",
    "scripts/telegram/wiki-bot-vercel-handler.mjs",
    "scripts/bridge/release-config.mjs",
    "scripts/bridge/release-config.json",
    "shared/bridge-install-command.js",
    "scripts/catalogue/query.mjs",
    "scripts/catalogue/public-assets.mjs",
    "scripts/catalogue/item-facts.mjs",
  ];
  functionFiles(
    "api/telegram/bot-webhook",
    wikiBotFiles,
    "export {default} from './api/telegram/bot-webhook.js';",
  );
  packageSeed(
    root,
    resolve(
      output,
      "functions/api/telegram/bot-webhook.func/local-data/madhouse.sqlite",
    ),
  );
  const feedbackFiles = [
    "api/feedback.js",
    "scripts/telegram/feedback-api.mjs",
    "scripts/telegram/telegram-init-data.mjs",
    "scripts/telegram/wiki-api-vercel-handler.mjs",
  ];
  functionFiles(
    "api/feedback",
    feedbackFiles,
    "export {default} from './api/feedback.js';",
    true,
  );
  const analyticsFiles = [
    "api/analytics.js",
    "scripts/analytics/wiki-analytics-api.mjs",
    "scripts/analytics/wiki-analytics-store.mjs",
    "scripts/storage/client.mjs",
    "scripts/telegram/telegram-init-data.mjs",
    "scripts/telegram/wiki-api-vercel-handler.mjs",
    "scripts/telegram/raid-blob-etag.mjs",
  ];
  functionFiles(
    "api/analytics",
    analyticsFiles,
    "export {default} from './api/analytics.js';",
    true,
  );
  const cleanupFiles = [
    "api/analytics-cleanup.js",
    "scripts/analytics/wiki-analytics-api.mjs",
    "scripts/analytics/wiki-analytics-store.mjs",
    "scripts/storage/client.mjs",
    "scripts/telegram/telegram-init-data.mjs",
    "scripts/telegram/wiki-api-vercel-handler.mjs",
    "scripts/telegram/raid-blob-etag.mjs",
  ];
  functionFiles(
    "api/analytics-cleanup",
    cleanupFiles,
    "export {default} from './api/analytics-cleanup.js';",
    true,
  );
  const catalogueFiles = [
    "api/catalogue.js",
    "scripts/catalogue/sync-api.mjs",
    "shared/wiki-session.js",
    "scripts/catalogue/store.mjs",
    "scripts/catalogue/query.mjs",
    "scripts/catalogue/projection.mjs",
    "scripts/catalogue/public-assets.mjs",
    "scripts/catalogue/item-facts.mjs",
    "scripts/catalogue/schema.sql",
    "scripts/catalogue/reference-blob-store.mjs",
    "scripts/storage/client.mjs",
    "scripts/telegram/raid-blob-etag.mjs",
    "scripts/telegram/wiki-api-vercel-handler.mjs",
  ];
  functionFiles(
    "api/catalogue",
    catalogueFiles,
    "export {default} from './api/catalogue.js';",
    true,
    60,
  );
  cpSync(
    resolve(root, "scripts/catalogue/schema.sql"),
    resolve(output, "functions/api/catalogue.func/schema.sql"),
  );
  packageSeed(
    root,
    resolve(output, "functions/api/catalogue.func/local-data/madhouse.sqlite"),
  );
  routes.push({ src: "/api/feedback", dest: "/api/feedback" });
  routes.push({ src: "/api/analytics", dest: "/api/analytics" });
  routes.push({
    src: "/api/analytics-cleanup",
    dest: "/api/analytics-cleanup",
  });
  routes.push({ src: "/api/catalogue", dest: "/api/catalogue" });
  routes.push({ src: "/api/raids", dest: "/api/raids" });
  routes.push({
    src: "/api/telegram/raids-sync",
    dest: "/api/telegram/raids-sync",
  });
  routes.push({
    src: "/api/telegram/bot-webhook",
    dest: "/api/telegram/bot-webhook",
  });
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
  JSON.stringify(
    {
      version: 3,
      routes,
      overrides,
      ...(service === "wiki" &&
      process.env.MADHOUSE_DISABLE_ANALYTICS_CRON !== "1"
        ? {
            crons: [{ path: "/api/analytics-cleanup", schedule: "17 4 * * *" }],
          }
        : {}),
    },
    null,
    2,
  ),
);
console.log("Vercel Build Output prepared", { service, sourceCommit });
