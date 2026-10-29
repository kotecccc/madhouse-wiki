// Isolated development harness. All game responses are synthetic and in-process.
import { createHmac, randomBytes, webcrypto } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";
import config from "../../vite.config.js";
import { createAutomationRuntime } from "../automation/runtime.mjs";
import { createAutomationStateStore } from "../automation/state-store.mjs";
import { isGameApiPath } from "../../api/[...path].js";
import { createWikiSessionAuthority } from "../../shared/wiki-session.js";

const directory = process.argv[2];
if (!directory || !resolve(directory).startsWith("/tmp/")) {
  throw new Error("Pass a dedicated directory under /tmp");
}
const root = resolve(directory);
const port = Number(
  process.env.MADHOUSE_FAKE_GAME_STAND_PORT || process.argv[3] || 43774,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Fake stand port must be an integer between 1024 and 65535");
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
const secondTokenFile = resolve(root, "token-b");
const secondToken = existsSync(secondTokenFile)
  ? readFileSync(secondTokenFile, "utf8").trim()
  : [
      token.split(".")[0],
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 }),
      ).toString("base64url"),
      randomBytes(24).toString("base64url"),
    ].join(".");
if (!existsSync(secondTokenFile))
  writeFileSync(secondTokenFile, secondToken + "\n", {
    mode: 0o600,
    flag: "wx",
  });
const profile = {
  playerId: 2042,
  telegramId: 42,
  nickname: "Fake player",
  level: 1,
};
// Fixed, test-only keys and an encrypted synthetic account record let the
// normal Wiki session verifier run without Telegram, connector, or game auth.
const testEncryptionKey = "11".repeat(32);
const testSigningKey = "22".repeat(32);
const telegramUserId = "42";
const accountDigest = createHmac(
  "sha256",
  Buffer.from(testEncryptionKey, "hex"),
)
  .update(`account:${telegramUserId}`)
  .digest("hex");
const accountPath = `accounts/${accountDigest}.json`;
const fakeAccountRecord = {
  playerId: profile.playerId,
  telegramUserId,
  revoked: false,
  expiresAt: Date.now() + 86400000,
  revision: "00000000-0000-4000-8000-000000000042",
};
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const cryptoKey = await webcrypto.subtle.importKey(
  "raw",
  Buffer.from(testEncryptionKey, "hex"),
  "AES-GCM",
  false,
  ["encrypt"],
);
const encryptedRecord = await webcrypto.subtle.encrypt(
  {
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(accountPath),
  },
  cryptoKey,
  new TextEncoder().encode(JSON.stringify(fakeAccountRecord)),
);
const wikiSessionAuthority = createWikiSessionAuthority({
  store: {
    async read(path) {
      return path === accountPath
        ? {
            value: JSON.stringify({
              v: 1,
              iv: Buffer.from(iv).toString("base64url"),
              data: Buffer.from(encryptedRecord).toString("base64url"),
            }),
          }
        : null;
    },
  },
  encryptionKey: testEncryptionKey,
  signingKey: testSigningKey,
});
let fakeCallCount = 0;
const fakeCalls = [];
let browserBootstrapStatus = "disabled";
const stateDirectory = resolve(root, "state");
const fixtureStore = createAutomationStateStore({ directory: stateDirectory });
if (!fixtureStore.read(profile.playerId))
  fixtureStore.write(profile.playerId, {
    schemaVersion: 1,
    raidObservations: [1, 2, 3].map((number) => ({
      leaderPlayerId: 43,
      bossId: 1,
      battleId: `fixture-raid-${number}`,
      seenAt: Date.now(),
    })),
  });
fixtureStore.close();
const bootstrapScript = `const ENABLED = "madhouse.fake-stand.enabled";
const report = (status) => fetch("/__fake/bootstrap-status", { method: "POST", body: status, cache: "no-store" }).catch(() => {});
const readEnabled = () => { try { return localStorage.getItem(ENABLED) === "1"; } catch { return false; } };
if (readEnabled()) {
  await report("started");
  try {
    const launchData = "user=" + encodeURIComponent(JSON.stringify({ id: 42 }));
    history.replaceState(null, "", location.pathname + "#tgWebAppData=" + encodeURIComponent(launchData));
    const auth = await import("/shared/auth-session.js");
    const sessions = await import("/shared/session-api.js");
    const unsubscribe = auth.subscribeSession(() => {
      const state = auth.readSession();
      if (state.status !== "ready" && !state.wikiSessionReady) {
        try { localStorage.removeItem(ENABLED); } catch { /* storage disabled */ }
        report("logged-out");
        unsubscribe();
      }
    });
    const fixture = await fetch("/__fake/status", { cache: "no-store" }).then(r => r.json());
    const wikiResponse = await fetch("/__fake/session", { cache: "no-store" });
    if (!wikiResponse.ok) throw new Error("fake_session_unavailable");
    const wiki = await wikiResponse.json();
    if (fixture.mode !== "wiki-only") {
      const gameResponse = await fetch("/__fake/game-session", { cache: "no-store" });
      if (!gameResponse.ok) throw new Error("fake_game_session_unavailable");
      const game = await gameResponse.json();
      auth.saveToken(game.gameCredential);
    }
    auth.saveWikiSession(wiki.wikiSession, { expiresAt: wiki.expiresAt, gameConnection: fixture.mode === "wiki-only" ? "login-required" : "connected" });
    await sessions.readStoredSessionJson("/api/automation/state");
    await report("complete");
  } catch {
    try { localStorage.removeItem(ENABLED); } catch { /* storage disabled */ }
    await report("failed");
    document.dispatchEvent(new CustomEvent("madhouse:fake-stand-error"));
  }
}`;
const fakeFetch = async (url, init = {}) => {
  const path = new URL(url).pathname;
  const headers = new Headers(init.headers);
  const auth = headers.get("authorization");
  if (auth !== `Bearer ${token}` && auth !== `Bearer ${secondToken}`)
    return Response.json({ error: "fake_token_required" }, { status: 401 });
  const mode = readFileSync(modeFile, "utf8").trim();
  fakeCallCount += 1;
  fakeCalls.push(`${init.method || "GET"} ${path} mode=${mode}`);
  console.log(`FAKE ${init.method || "GET"} ${path} mode=${mode}`);
  if (mode === "hold") {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 30000);
      init.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    throw new Error("fake_game_held");
  }
  if (mode === "offline") throw new Error("fake_game_offline");
  if (mode === "429")
    return Response.json(
      { error: "fake_rate_limit" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  if ((init.method || "GET") !== "GET")
    return Response.json({ error: "fake_mutations_disabled" }, { status: 403 });
  if (path === "/api/me")
    return Response.json(
      auth === `Bearer ${secondToken}`
        ? {
            ...profile,
            playerId: 2043,
            telegramId: 43,
            nickname: "Fake player B",
          }
        : profile,
    );
  if (path === "/api/me/bag")
    return Response.json({ activityItems: [], consumables: [] });
  if (path === "/api/combat") return Response.json({ activeBattle: null });
  if (path === "/api/bosses/invitations")
    return Response.json({
      items:
        mode === "ui-raid"
          ? [
              {
                invitationId: "fixture-invitation",
                battleId: "fixture-raid-3",
                bossId: 1,
                leaderPlayerId: 43,
                inviterPlayerId: 43,
                peerPlayerId: 43,
                peerNickname: "FakeLeader",
                status: "pending",
                battleStatus: "active",
                expiresAtUtc: new Date(Date.now() + 3600000).toISOString(),
                battleExpiresAtUtc: new Date(
                  Date.now() + 3600000,
                ).toISOString(),
              },
            ]
          : [],
    });
  return Response.json(
    { error: "fake_route_unimplemented", path },
    { status: 501 },
  );
};
const runtime = await createAutomationRuntime({
  root: process.cwd(),
  env: {
    MADHOUSE_AUTOMATION_STATE_DIR: stateDirectory,
    MADHOUSE_AUTOMATION_GAME_ENABLED: "1",
    WIKI_SESSION_KEY: testSigningKey,
    ACCOUNT_SESSION_KEY: testEncryptionKey,
  },
  wikiSessionAuthority,
  gameFetcher: fakeFetch,
});
const fakePlugin = {
  name: "isolated-fake-game",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      );
      const path = (req.url || "").split("?")[0];
      if (path === "/__fake/session" && req.method === "GET") {
        const credential = await wikiSessionAuthority.mint(
          accountPath,
          fakeAccountRecord,
          telegramUserId,
        );
        if (!(await wikiSessionAuthority.verify(credential)))
          throw new Error("fake_wiki_session_verification_failed");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            wikiSession: credential,
            playerId: profile.playerId,
            expiresAt: fakeAccountRecord.expiresAt,
          }),
        );
        return;
      }
      if (path === "/__fake/game-session" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const gameCredential =
          readFileSync(modeFile, "utf8").trim() === "expiring"
            ? [
                token.split(".")[0],
                Buffer.from(
                  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 5 }),
                ).toString("base64url"),
                token.split(".")[2],
              ].join(".")
            : token;
        res.end(JSON.stringify({ gameCredential }));
        return;
      }
      if (path === "/__fake/bootstrap.js" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.end(bootstrapScript);
        return;
      }
      if (path === "/__fake/connect" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Fake Wiki session</title><body><main><h1>Изолированная тестовая сессия</h1><p>Кнопка подключит этот браузер к локальному fake стенду. Тестовые credentials не являются игровыми и не отправляются в игру.</p><button id="connect" type="button">Подключить тестовую сессию</button><p id="status" role="status"></p><script>
          document.querySelector('#connect').addEventListener('click', () => {
            try { localStorage.setItem('madhouse.fake-stand.enabled', '1'); }
            catch { document.querySelector('#status').textContent = 'Локальное хранилище недоступно'; return; }
            location.href = '/';
          });
        </script></main></body></html>`);
        return;
      }
      if (path === "/__fake/status" && req.method === "GET") {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            mode: readFileSync(modeFile, "utf8").trim(),
            gameCallCount: fakeCallCount,
            calls: fakeCalls,
            browserBootstrapStatus,
          }),
        );
        return;
      }
      if (path === "/__fake/bootstrap-status" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const value = Buffer.concat(chunks).toString("utf8");
        if (!["started", "complete", "failed", "logged-out"].includes(value)) {
          res.writeHead(400);
          return res.end();
        }
        browserBootstrapStatus = value;
        res.writeHead(204, { "Cache-Control": "no-store" });
        return res.end();
      }
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
  transformIndexHtml: {
    order: "post",
    handler(html) {
      return html.replace(
        "</body>",
        '<script type="module" src="/__fake/bootstrap.js"></script></body>',
      );
    },
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
  server: { host: "127.0.0.1", port, strictPort: true },
});
await server.listen();
console.log(
  `Fake Wiki: http://127.0.0.1:${port}/\nIsolated connect page: http://127.0.0.1:${port}/__fake/connect\nTest Wiki session: GET http://127.0.0.1:${port}/__fake/session\nFake call log: GET http://127.0.0.1:${port}/__fake/status\nGame token file: ${root}/token\nMode file: ${modeFile}`,
);
const stop = async () => {
  await server.close();
  runtime.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
