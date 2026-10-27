import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  cpSync,
} from "node:fs";
import { resolve, relative, extname } from "node:path";
import { productionConnectorConfig } from "./connector-release-config.mjs";
const root = process.cwd();
const commit = process.env.MADHOUSE_RELEASE_SHA;
if (!/^[a-f0-9]{40}$/.test(commit || ""))
  throw new Error(
    "Set MADHOUSE_RELEASE_SHA to the published GitHub source commit",
  );
const dist = resolve(root, "dist");
const files = {};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else
      files["/" + relative(dist, path)] = {
        type: mime[extname(path)] || "application/octet-stream",
        body: readFileSync(path).toString("base64"),
      };
  }
}
collect(dist);
const connector = productionConnectorConfig(
  JSON.parse(readFileSync(resolve(dist, "connection-config.json"), "utf8")),
  process.env.MADHOUSE_REQUIRE_TELEGRAM_CONNECTOR === "1",
);
files["/release.json"] = {
  type: "application/json; charset=utf-8",
  body: Buffer.from(
    JSON.stringify({
      sourceRepository: "https://github.com/kotecccc/madhouse-wiki",
      sourceCommit: commit,
      provider: "Sites",
      catalogue: "reference-only-sqlite",
      telegramConnector: connector,
    }),
  ).toString("base64"),
};
// Sites has no access to the verified owner route store. Its legacy game API
// must stay retired until a route-aware adapter exists.
const worker = `const assets=${JSON.stringify(files)};\nexport default {async fetch(request){const url=new URL(request.url);if(url.pathname==='/api'||url.pathname.startsWith('/api/'))return new Response(JSON.stringify({error:'legacy_game_api_retired'}),{status:410,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});if(url.pathname==='/api-docs'||url.pathname==='/api-docs/')return Response.redirect(new URL('/api-docs/index.html',url),302);let file=assets[url.pathname];if(!file&&!url.pathname.includes('.'))file=assets['/index.html'];if(!file)return new Response('Not found',{status:404});return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(file.body),c=>c.charCodeAt(0)),{headers:{'Content-Type':file.type,'X-Content-Type-Options':'nosniff','Cache-Control':url.pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'}});}};\n`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, "server"), { recursive: true });
mkdirSync(resolve(dist, ".openai"), { recursive: true });
writeFileSync(resolve(dist, "server/index.js"), worker);
cpSync(".openai/hosting.json", resolve(dist, ".openai/hosting.json"));
console.log(
  "Sites Worker built from GitHub source",
  commit,
  "assets",
  Object.keys(files).length,
  "bytes",
  worker.length,
);
