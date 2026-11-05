import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const profile = {
  playerId: 42,
  nickname: "Tester",
  playerLevel: 7,
  exp: { level: 7 },
};

async function withProfileHook(run, { rejectAfter = Infinity } = {}) {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  const oldWindow = globalThis.window;
  const oldFetch = globalThis.fetch;
  const oldAct = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const storage = new Map();
  const browserWindow = new EventTarget();
  const user = encodeURIComponent(JSON.stringify({ id: 42 }));
  const initData = `user=${user}&hash=test`;
  browserWindow.location = {
    origin: "http://localhost",
    hash: `#tgWebAppData=${encodeURIComponent(initData)}`,
  };
  browserWindow.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  browserWindow.setInterval = () => 1;
  browserWindow.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.window = browserWindow;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let renderer;
  let auth;
  let reads = 0;
  globalThis.fetch = async (input, init) => {
    const path = new URL(input, "http://localhost").pathname;
    assert.equal(init.headers["X-Madhouse-Stored-Only"], "1");
    if (path === "/api/me/bag")
      return Response.json(
        { data: [] },
        {
          headers: { "X-Madhouse-Section-Updated": String(Date.now()) },
        },
      );
    assert.equal(path, "/api/me");
    reads++;
    if (reads >= rejectAfter)
      return Response.json(
        {},
        {
          status: 503,
          headers: { "X-Madhouse-Game-Status": "unavailable" },
        },
      );
    return Response.json(profile, {
      headers: { "X-Madhouse-Section-Updated": String(Date.now()) },
    });
  };

  try {
    const { usePlayerProfile } = await server.ssrLoadModule(
      "/src/features/auth/usePlayerProfile.js",
    );
    auth = await server.ssrLoadModule("/shared/auth-session.js");
    const session = await server.ssrLoadModule("/shared/session-api.js");
    auth.saveWikiSession("wiki-session", {
      expiresAt: Date.now() + 60_000,
      gameConnection: "login-required",
    });
    let current;
    function Consumer() {
      current = usePlayerProfile();
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Consumer));
      for (
        let attempt = 0;
        attempt < 10 && (!current || current.status === "loading");
        attempt++
      )
        await new Promise((resolve) => setImmediate(resolve));
      if (current?.status === "loading")
        await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await run({
      auth,
      session,
      getCurrent: () => current,
      getReads: () => reads,
    });
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    auth?.clearToken();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
    await server.close();
  }
}

test("profile reloads after session data clears while the Wiki identity stays valid", async () => {
  await withProfileHook(async ({ auth, session, getCurrent, getReads }) => {
    assert.equal(auth.readSession().wikiSessionReady, true);
    assert.equal(getCurrent().status, "ready");
    assert.equal(getCurrent().profile.name, "Tester");
    assert.equal(getReads(), 1);

    await act(async () => {
      await assert.rejects(session.getSessionJson("/api/bosses/invitations"));
      for (
        let attempt = 0;
        attempt < 10 && getCurrent().status === "loading";
        attempt++
      )
        await new Promise((resolve) => setImmediate(resolve));
    });

    assert.equal(auth.readSession().wikiSessionReady, true);
    assert.equal(getReads(), 2);
    assert.equal(getCurrent().status, "ready");
    assert.equal(getCurrent().profile.name, "Tester");
  });
});

test("a rejected recovery read settles as an error without retrying indefinitely", async () => {
  await withProfileHook(
    async ({ session, getCurrent, getReads }) => {
      await act(async () => {
        await assert.rejects(session.getSessionJson("/api/bosses/invitations"));
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.equal(getReads(), 2);
      assert.equal(getCurrent().status, "error");
      assert.equal(getCurrent().profile, null);
    },
    { rejectAfter: 2 },
  );
});

test("logout clears the previous profile without restoring it from stale state", async () => {
  await withProfileHook(async ({ auth, getCurrent }) => {
    assert.equal(getCurrent().profile.name, "Tester");
    await act(async () => {
      auth.clearToken();
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(getCurrent().status, "idle");
    assert.equal(getCurrent().profile, null);
  });
});
