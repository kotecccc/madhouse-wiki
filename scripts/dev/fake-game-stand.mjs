// Isolated development harness. All game responses are synthetic and in-process.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import config from "../../vite.config.js";
import { createAutomationRuntime } from "../automation/runtime.mjs";
import { isGameApiPath } from "../../api/[...path].js";

const directory = process.argv[2];
if (!directory || !resolve(directory).startsWith("/tmp/")) {
  throw new Error("Pass a dedicated directory under /tmp");
}
const root = resolve(directory);
mkdirSync(root, { recursive: true });
const modeFile = resolve(root, "mode");
if (!existsSync(modeFile)) writeFileSync(modeFile, "online\n", { flag: "wx" });
const tokenFile = resolve(root, "token");
const token = existsSync(tokenFile)
  ? readFileSync(tokenFile, "utf8").trim()
  : [
      Buffer.from('{"alg":"HS256"}').toString("base64url"),
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }),
      ).toString("base64url"),
      randomBytes(24).toString("base64url"),
    ].join(".");
if (!existsSync(tokenFile))
  writeFileSync(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
const profile = {
  playerId: 2042,
  telegramId: 42,
  nickname: "Fake player",
  level: 1,
};
const fakeFetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const headers = new Headers(init.headers);
  if (headers.get("authorization") !== `Bearer ${token}`)
    return Response.json({ error: "fake_token_required" }, { status: 401 });
  const mode = readFileSync(modeFile, "utf8").trim();
  console.log(`FAKE ${init.method || "GET"} ${path} mode=${mode}`);
  if (mode === "offline") throw new Error("fake_game_offline");
  if (mode === "429")
    return Response.json(
      { error: "fake_rate_limit" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  if ((init.method || "GET") !== "GET")
    return Response.json({ error: "fake_mutations_disabled" }, { status: 403 });
  if (path === "/api/me") return Response.json(profile);
  return Response.json([]);
};
const runtime = await createAutomationRuntime({
  root: process.cwd(),
  env: {
    MADHOUSE_AUTOMATION_STATE_DIR: resolve(root, "state"),
    MADHOUSE_AUTOMATION_GAME_ENABLED: "1",
  },
  gameFetcher: fakeFetch,
});
const fakePlugin = {
  name: "isolated-fake-game",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      );
      const path = (req.url || "").split("?")[0];
      if (path.startsWith("/api/automation/"))
        return runtime.nodeHandler(req, res);
      if (isGameApiPath(path)) return runtime.proxy(req, res);
      if (path.startsWith("/api/")) {
        res.writeHead(404);
        return res.end();
      }
      return next();
    });
  },
};
const server = await createServer({
  ...config,
  configFile: false,
  envFile: false,
  define: {
    "import.meta.env.VITE_TELEGRAM_CONNECTOR_ORIGIN": '""',
    "import.meta.env.VITE_MADHOUSE_BRIDGE_BOOTSTRAP_SHA256": '""',
  },
  plugins: [
    fakePlugin,
    ...config.plugins.filter(
      (p) =>
        !["server-owned-automations", "catalogue-session-sync"].includes(
          p.name,
        ),
    ),
  ],
  server: { host: "127.0.0.1", port: 43774, strictPort: true },
});
await server.listen();
console.log(
  `Fake Wiki: http://127.0.0.1:43774/\nToken file: ${root}/token\nMode file: ${modeFile}`,
);
const stop = async () => {
  await server.close();
  runtime.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
