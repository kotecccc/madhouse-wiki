import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { act, create } from "react-test-renderer";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";

test("a mounted business consumer receives worker observations and unsubscribes", async () => {
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
  const window = new EventTarget();
  window.location = { origin: "http://localhost", hash: "" };
  window.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  window.setInterval = () => 1;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.window = window;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer;
  let auth;
  try {
    const { useBusinessState } = await server.ssrLoadModule(
      "/src/features/businesses/state/useBusinessState.js",
    );
    const { BusinessCard } = await server.ssrLoadModule(
      "/src/features/businesses/BusinessCard/BusinessCard.jsx",
    );
    auth = await server.ssrLoadModule("/shared/auth-session.js");
    const session = await server.ssrLoadModule("/shared/session-api.js");
    const token = [
      Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
      Buffer.from(
        JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
      ).toString("base64url"),
      "fake-signature",
    ].join(".");
    const authorization = `Bearer ${token}`;
    const rows = new Map();
    const store = {
      readSnapshots: () => [...rows.values()],
      writeSnapshot: (id, value) =>
        rows.set(String(id), structuredClone(value)),
      list: () => [],
    };
    let clock = 1000;
    let level = 1;
    let gameReads = 0;
    let storedReads = 0;
    const snapshots = createAccountSnapshots({
      store,
      now: () => clock,
      fetcher: async () => {
        gameReads++;
        return Response.json({ id: 7, level });
      },
    });
    snapshots.saveBridgeProfile(authorization, { playerId: 42 });
    const url = "https://cargohustle.online/api/businesses/7";
    await snapshots.liveFetch(url, {
      headers: { Authorization: authorization },
    });
    globalThis.fetch = async (input, init) => {
      const path = new URL(input, "http://localhost").pathname;
      assert.equal(path, "/api/businesses/7");
      if (init.headers["X-Madhouse-Stored-Only"]) {
        storedReads++;
        return snapshots.readStored(url, init);
      }
      return snapshots.read(url, init);
    };
    auth.saveToken(token);
    let current;
    function BusinessScreenConsumer() {
      current = useBusinessState({ apiId: 7 });
      return null;
    }
    await act(async () => {
      renderer = create(
        createElement(
          Fragment,
          null,
          createElement(BusinessCard, {
            business: { id: "business:7", apiId: 7, title: "Fake" },
          }),
          createElement(BusinessScreenConsumer),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(current.level, 1);
    assert.equal(storedReads, 1);
    session.publishSessionData(
      "/api/automation/state",
      {
        version: 1,
        queuedActions: [],
        resourceVersions: snapshots.resourceVersions(authorization),
      },
      authorization,
    );
    level = 2;
    clock++;
    await snapshots.liveFetch(url, {
      headers: { Authorization: authorization },
    });
    const readsAfterWorker = gameReads;
    await act(async () => {
      session.publishSessionData(
        "/api/automation/state",
        {
          version: 2,
          queuedActions: [],
          resourceVersions: snapshots.resourceVersions(authorization),
        },
        authorization,
      );
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.equal(current.level, 2);
    assert.equal(gameReads, readsAfterWorker);
    await act(async () => renderer.unmount());
    const before = storedReads;
    const ticket = snapshots.beginMutation(
      authorization,
      "POST",
      "/api/shop/buy",
    );
    assert.equal(snapshots.commitMutationBarrier(ticket), true);
    session.publishSessionData(
      "/api/automation/state",
      {
        version: 3,
        queuedActions: [],
        resourceVersions: snapshots.resourceVersions(authorization),
      },
      authorization,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(storedReads, before);
    assert.equal(gameReads, readsAfterWorker);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
    auth?.clearToken();
    globalThis.window = oldWindow;
    globalThis.fetch = oldFetch;
    globalThis.IS_REACT_ACT_ENVIRONMENT = oldAct;
    await server.close();
  }
});
