import { copyFileSync, createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createVercelConnectorHandler } from "./vercel-connector-handler.mjs";
import { connectorHeaders } from "../../connector/worker.js";
import { startVpsInlineCards } from "../telegram/inline-cards-vps.mjs";
import { VERSION } from "../../connector/protocol.js";
import { createVpsBridgeLab } from "../bridge/vps-lab.mjs";
import { createBridgeReleaseHttp } from "../bridge/release-http.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const role = process.argv[2] || process.env.MADHOUSE_SERVICE;
if (!new Set(["wiki", "connector"]).has(role))
  throw new Error("MADHOUSE_SERVICE must be wiki or connector");

if (role === "wiki") {
  const catalogueFile = resolve(
    tmpdir(),
    `madhouse-wiki-catalogue-${process.pid}.sqlite`,
  );
  copyFileSync(resolve(root, "local-data/madhouse.sqlite"), catalogueFile);
  process.env.MADHOUSE_CATALOGUE_DB = catalogueFile;
}

const sourceCommit = process.env.MADHOUSE_RELEASE_SHA || "unknown";
if (!/^[a-f0-9]{40}$/.test(sourceCommit))
  throw new Error("MADHOUSE_RELEASE_SHA must be a full source commit SHA");

const wikiOrigin = process.env.WIKI_PUBLIC_ORIGIN || "https://madhouse-wiki.ru";
const connectorOrigin =
  process.env.CONNECTOR_PUBLIC_ORIGIN || "https://connect.madhouse-wiki.ru";
for (const [name, value] of [
  ["WIKI_PUBLIC_ORIGIN", wikiOrigin],
  ["CONNECTOR_PUBLIC_ORIGIN", connectorOrigin],
]) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be an HTTPS origin`);
}
if (wikiOrigin === connectorOrigin)
  throw new Error("Wiki and connector require separate origins");
const bridgeLab = createVpsBridgeLab({
  role,
  env: process.env,
  wikiOrigin,
  connectorOrigin,
});
const bridgeRelease =
  bridgeLab?.runtime && process.env.MADHOUSE_BRIDGE_RELEASE_DIR
    ? createBridgeReleaseHttp(process.env.MADHOUSE_BRIDGE_RELEASE_DIR)
    : null;
if (bridgeLab?.privateServer) bridgeLab.privateServer.listen(9094, "0.0.0.0");

const wikiOrigins = [
  ...new Set([
    wikiOrigin,
    ...(process.env.CONNECTOR_LEGACY_WIKI_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]),
];
const noStore = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const connectorSecurity =
  role === "connector" ? connectorHeaders(wikiOrigins) : {};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });

let apiHandlers;
let automationRuntime;
if (role === "wiki") {
  const [catalogue, raids, feedback, analytics, cleanup, bot, raidsSync] =
    await Promise.all([
      import("../../api/catalogue.js"),
      import("../../api/raids.js"),
      import("../../api/feedback.js"),
      import("../../api/analytics.js"),
      import("../../api/analytics-cleanup.js"),
      import("../../api/telegram/bot-webhook.js"),
      import("../../api/telegram/raids-sync.js"),
    ]);
  const { createAutomationRuntime } = await import("../automation/runtime.mjs");
  automationRuntime = await createAutomationRuntime({
    root,
    bridge: bridgeLab?.runtime || null,
  });
  apiHandlers = new Map([
    ["/api/automation/state", automationRuntime.nodeHandler],
    ["/api/automation/launch", automationRuntime.nodeHandler],
    ["/api/automation/commands", automationRuntime.nodeHandler],
    ["/api", automationRuntime.proxy],
    [
      "/api/catalogue",
      automationRuntime.bridgeActive
        ? catalogue.createCatalogueHandler({
            fetcher: automationRuntime.gameFetch,
          })
        : catalogue.default,
    ],
    ["/api/raids", raids.default],
    ["/api/feedback", feedback.default],
    ["/api/analytics", analytics.default],
    ["/api/analytics-cleanup", cleanup.default],
    ["/api/telegram/bot-webhook", bot.default],
    ["/api/telegram/raids-sync", raidsSync.default],
  ]);
} else {
  const makeConnectorHandler = (endpoint) =>
    createVercelConnectorHandler({
      wikiOrigin,
      wikiOrigins,
      connectorOrigin,
      endpoint,
      ...(bridgeLab?.guard ? { connectorGuard: bridgeLab.guard } : {}),
    });
  apiHandlers = new Map([
    ["/api/config", makeConnectorHandler("/api/config")],
    ["/api/game-session", makeConnectorHandler("/api/game-session")],
    ["/api/account-session", makeConnectorHandler("/api/account-session")],
    ["/api/unknown", makeConnectorHandler("/api/unknown")],
  ]);
}

const inlineCards = startVpsInlineCards({ root });

const assetsRoot = resolve(root, role === "wiki" ? "dist" : "connector/dist");
const releaseMarker =
  role === "wiki"
    ? {
        sourceRepository: "https://github.com/kotecccc/madhouse-wiki",
        sourceCommit,
        provider: "VPS",
        catalogue: "reference-only-sqlite",
        telegramConnector: {
          origin: connectorOrigin,
          protocolVersion: VERSION,
        },
      }
    : {
        service: "telegram-connector",
        sourceCommit,
        protocolVersion: VERSION,
        wikiOrigin,
        connectorOrigin,
        provider: "VPS",
      };

function headerRecord(headers) {
  const output = {};
  for (const [key, value] of headers) output[key] = value;
  return output;
}

async function writeFetchResponse(response, result, security = {}) {
  response.writeHead(result.status, {
    ...headerRecord(result.headers),
    ...security,
  });
  response.end(Buffer.from(await result.arrayBuffer()));
}

function readStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const relative = decoded.replace(/^\/+/, "");
  const file = resolve(assetsRoot, relative || "index.html");
  if (file !== assetsRoot && !file.startsWith(assetsRoot + sep)) return null;
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const server = createServer(async (request, response) => {
  try {
    const method = request.method || "GET";
    const url = new URL(request.url || "/", "http://localhost");
    if (
      role === "wiki" &&
      bridgeRelease &&
      url.pathname.startsWith("/bridge/")
    ) {
      bridgeRelease(request, response);
      return;
    }
    if (url.pathname === "/healthz" && method === "GET") {
      await writeFetchResponse(
        response,
        json({ service: role, sourceCommit }, 200, noStore),
        connectorSecurity,
      );
      return;
    }
    if (url.pathname === "/release.json" && ["GET", "HEAD"].includes(method)) {
      const result = json(releaseMarker, 200, {
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      if (method === "HEAD") {
        response.writeHead(200, {
          ...headerRecord(result.headers),
          ...connectorSecurity,
        });
        response.end();
      } else await writeFetchResponse(response, result, connectorSecurity);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      if (
        role === "wiki" &&
        bridgeLab?.adapter &&
        url.pathname.startsWith("/api/bridge/")
      ) {
        await bridgeLab.adapter.handle(request, response);
        return;
      }
      if (role === "connector") {
        const handler =
          apiHandlers.get(url.pathname) || apiHandlers.get("/api/unknown");
        await handler(request, response);
        return;
      }
      const handler = /^\/api\/automation(?:\/|$)/.test(url.pathname)
        ? automationRuntime.nodeHandler
        : apiHandlers.get(url.pathname) || apiHandlers.get("/api");
      await handler(request, response);
      return;
    }
    if (!new Set(["GET", "HEAD"]).has(method)) {
      response.writeHead(405, {
        ...noStore,
        ...connectorSecurity,
        Allow: "GET, HEAD",
      });
      response.end("Method not allowed");
      return;
    }
    if (role === "wiki" && ["/api-docs", "/api-docs/"].includes(url.pathname)) {
      response.writeHead(302, {
        ...noStore,
        ...connectorSecurity,
        Location: `/api-docs/index.html${url.search}`,
      });
      response.end();
      return;
    }
    if (role === "wiki" && url.pathname.startsWith("/inline-cards/")) {
      const card = inlineCards.get(url.pathname);
      const ready = inlineCards.status === "ready";
      response.writeHead(card ? 200 : ready ? 404 : 503, {
        "Content-Type": card ? "image/jpeg" : "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
        ...(!ready ? { "Retry-After": "30" } : {}),
        "X-Content-Type-Options": "nosniff",
      });
      response.end(
        method === "HEAD"
          ? undefined
          : card || (ready ? "Not found" : "Telegram cards are not ready"),
      );
      return;
    }
    let file = readStatic(url.pathname);
    if (!file && role === "wiki" && !url.pathname.includes("."))
      file = readStatic("/index.html");
    if (!file) {
      response.writeHead(404, {
        ...noStore,
        ...connectorSecurity,
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        mimeTypes.get(extname(file)) || "application/octet-stream",
      ...connectorSecurity,
      "Cache-Control": url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (method === "HEAD") response.end();
    else createReadStream(file).pipe(response);
  } catch {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(503, {
        ...noStore,
        ...connectorSecurity,
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end('{"error":"service_unavailable"}');
    }
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
if (bridgeLab?.adapter) server.on("upgrade", bridgeLab.adapter.upgrade);
server.listen(
  Number(process.env.PORT || (role === "wiki" ? 9092 : 9093)),
  "0.0.0.0",
);

server.once("close", () => {
  automationRuntime?.close();
  bridgeLab?.privateServer?.close();
  bridgeLab?.runtime?.close();
});
