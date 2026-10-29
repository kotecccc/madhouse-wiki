import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirectBoundary } from "../scripts/game/direct-boundary.mjs";
import {
  createDirectGameIpcClient,
  createDirectGameIpcServer,
} from "../scripts/game/direct-ipc.mjs";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";
import { createVercelConnectorHandler } from "../scripts/deploy/vercel-connector-handler.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import {
  createDirectVpsConnector,
  createDirectVpsOwner,
} from "../scripts/game/direct-vps.mjs";

test("Wiki runtime and the production connector adapter share the physical direct sender", async () => {
  const directory = mkdtempSync(join(tmpdir(), "direct-vps-"));
  const calls = [];
  const secret = "c".repeat(64);
  const direct = createDirectVpsOwner({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "15",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "15",
      MADHOUSE_GAME_EXECUTOR_KEY: secret,
    },
    fetcher: async (url) => {
      calls.push({ path: new URL(url).pathname, at: Date.now() });
      if (new URL(url).pathname === "/api/auth/telegram")
        return Response.json({ accessToken: "abc.def.ghi" });
      return Response.json({ playerId: 41 });
    },
  });
  const { boundary, server: ipc } = direct;
  await new Promise((resolve) => ipc.listen(0, "127.0.0.1", resolve));
  const ipcPort = ipc.address().port;
  const client = createDirectVpsConnector({
    env: {
      MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://wiki:9095",
      MADHOUSE_GAME_EXECUTOR_KEY: secret,
    },
    fetcher: (_url, init) =>
      fetch(`http://127.0.0.1:${ipcPort}/internal/game/direct`, init),
  });
  const connector = createVercelConnectorHandler({
    wikiOrigin: "https://wiki.test",
    connectorOrigin: "https://connector.test",
    endpoint: "/api/game-session",
    fetcher: client,
  });
  const connectorServer = createServer(connector);
  await new Promise((resolve) =>
    connectorServer.listen(0, "127.0.0.1", resolve),
  );
  let runtime;
  try {
    runtime = await createAutomationRuntime({
      env: {
        MADHOUSE_AUTOMATION_STATE_DIR: directory,
        MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
      },
      gameFetcher: direct.wikiFetch,
    });
    const initData = new URLSearchParams({
      hash: "a".repeat(64),
      user: JSON.stringify({ id: 1 }),
      auth_date: "1",
    }).toString();
    const wikiResult = { setHeader() {}, end() {} };
    const [, login] = await Promise.all([
      runtime.proxy(
        {
          method: "GET",
          url: "/api/me",
          headers: { authorization: "Bearer abc.def.ghi" },
        },
        wikiResult,
      ),
      fetch(
        `http://127.0.0.1:${connectorServer.address().port}/api/game-session`,
        {
          method: "POST",
          headers: {
            Origin: "https://connector.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ initData }),
        },
      ),
    ]);
    assert.equal(wikiResult.statusCode, 200);
    assert.equal(login.status, 200);
    assert.deepEqual(calls.map((call) => call.path).sort(), [
      "/api/auth/telegram",
      "/api/me",
    ]);
    assert.ok(Math.abs(calls[1].at - calls[0].at) >= 12);
    assert.deepEqual(
      new Set(boundary.diagnostics().recent.map((event) => event.source)),
      new Set(["proxy", "connector"]),
    );
  } finally {
    runtime?.close();
    boundary.close();
    await Promise.all([
      new Promise((resolve) => ipc.close(resolve)),
      new Promise((resolve) => connectorServer.close(resolve)),
    ]);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a raw 429 imposes account cooldown before a saved snapshot is returned", async () => {
  let clock = 1000;
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(id, structuredClone(value)),
    list: () => [],
  };
  const calls = [];
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
    },
    fetcher: async (url) => {
      calls.push({ path: new URL(url).pathname, at: Date.now() });
      if (calls.length === 3)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "0.12" },
        });
      return Response.json(
        new URL(url).pathname === "/api/me" ? { playerId: 41 } : [],
      );
    },
  });
  const snapshots = createAccountSnapshots({
    store,
    fetcher: (url, init) => boundary.request(url, init, "wiki"),
    now: () => clock,
    ttl: 10,
  });
  const secret = "d".repeat(64);
  const ipc = createDirectGameIpcServer({
    secret,
    execute: (url, init) => boundary.request(url, init, "connector"),
  });
  await new Promise((resolve) => ipc.listen(0, "127.0.0.1", resolve));
  const client = createDirectGameIpcClient({
    endpoint: "http://wiki:9095/internal/game/direct",
    secret,
    fetcher: (_url, init) =>
      fetch(
        `http://127.0.0.1:${ipc.address().port}/internal/game/direct`,
        init,
      ),
  });
  const authorization = { headers: { Authorization: "Bearer token" } };
  try {
    await snapshots.read("https://cargohustle.online/api/me", authorization);
    await snapshots.read(
      "https://cargohustle.online/api/me/bag",
      authorization,
    );
    clock += 100;
    const stale = await snapshots.read(
      "https://cargohustle.online/api/me/bag",
      authorization,
    );
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-madhouse-snapshot"), "stale");
    const started = Date.now();
    await client("https://cargohustle.online/api/me", authorization);
    assert.ok(Date.now() - started >= 90);
    assert.equal(calls.length, 4);
    assert.ok(
      boundary
        .diagnostics()
        .recent.some((event) => event.outcome === "cooldown"),
    );
  } finally {
    boundary.close();
    await new Promise((resolve) => ipc.close(resolve));
  }
});

test("a connector binding changed while waiting prevents physical dispatch", async () => {
  let revision = "a".repeat(36);
  let calls = 0;
  const env = {
    MADHOUSE_GAME_EXECUTOR_KEY: "e".repeat(64),
    MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "100",
    MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
  };
  const owner = createDirectVpsOwner({
    env,
    fetcher: async () => {
      calls++;
      return Response.json({ playerId: 41 });
    },
    bindingCurrent: async (binding) => binding.revision === revision,
  });
  await new Promise((resolve) => owner.server.listen(0, "127.0.0.1", resolve));
  const client = createDirectVpsConnector({
    env: { ...env, MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://wiki:9095" },
    fetcher: (_url, init) =>
      fetch(
        `http://127.0.0.1:${owner.server.address().port}/internal/game/direct`,
        init,
      ),
  });
  try {
    await owner.wikiFetch("https://cargohustle.online/api/me", {
      headers: { Authorization: "Bearer first" },
    });
    const waiting = client("https://cargohustle.online/api/me", {
      headers: { Authorization: "Bearer second" },
      gameBinding: { accountPath: `accounts/${"f".repeat(64)}.json`, revision },
    });
    revision = "b".repeat(36);
    await assert.rejects(waiting, (error) => error.notDispatched === true);
    assert.equal(calls, 1);
  } finally {
    owner.boundary.close();
    await new Promise((resolve) => owner.server.close(resolve));
  }
});

test("a lost internal response after the auth POST stays uncertain and is not resent", async () => {
  let physicalCalls = 0;
  const secret = "d".repeat(64);
  const env = { MADHOUSE_GAME_EXECUTOR_KEY: secret };
  const owner = createDirectVpsOwner({
    env,
    fetcher: async () => {
      physicalCalls++;
      return Response.json({ accessToken: "abc.def.ghi" });
    },
  });
  await new Promise((resolve) => owner.server.listen(0, "127.0.0.1", resolve));
  const client = createDirectVpsConnector({
    env: { ...env, MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://wiki:9095" },
    fetcher: async (_url, init) => {
      const result = await fetch(
        `http://127.0.0.1:${owner.server.address().port}/internal/game/direct`,
        init,
      );
      await result.arrayBuffer();
      throw new Error("response lost");
    },
  });
  const connector = createVercelConnectorHandler({
    wikiOrigin: "https://wiki.test",
    connectorOrigin: "https://connector.test",
    endpoint: "/api/game-session",
    fetcher: client,
  });
  const server = createServer(connector);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const initData = new URLSearchParams({
      hash: "a".repeat(64),
      user: "{}",
      auth_date: "1",
    }).toString();
    const result = await fetch(
      `http://127.0.0.1:${server.address().port}/api/game-session`,
      {
        method: "POST",
        headers: {
          Origin: "https://connector.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ initData }),
      },
    );
    assert.equal(result.status, 502);
    assert.equal((await result.json()).error, "game_result_unknown");
    assert.equal(physicalCalls, 1);
  } finally {
    owner.boundary.close();
    await Promise.all([
      new Promise((resolve) => owner.server.close(resolve)),
      new Promise((resolve) => server.close(resolve)),
    ]);
  }
});

test("known credentials for one player share the account interval", async () => {
  const sent = [];
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "80",
    },
    resolvePlayer: () => 41,
    fetcher: async () => {
      sent.push(Date.now());
      return Response.json({});
    },
  });
  try {
    await Promise.all([
      boundary.request("https://cargohustle.online/api/floors", {
        headers: { Authorization: "Bearer one" },
      }),
      boundary.request("https://cargohustle.online/api/floors", {
        headers: { Authorization: "Bearer two" },
      }),
    ]);
    assert.equal(sent.length, 2);
    assert.ok(sent[1] - sent[0] >= 65);
  } finally {
    boundary.close();
  }
});
