import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { create } from "react-test-renderer";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createAutomationService } from "../automation/service.mjs";
import { createAutomationStateStore } from "../automation/state-store.mjs";
import { createRemoteBattleSession } from "../../src/features/bosses/BossBattle/boss-battle-remote.js";

const base = "fadb7693";
async function priorModule(path) {
  const text = execFileSync("git", ["show", `${base}:${path}`], {
    encoding: "utf8",
  });
  const root = dirname(resolve(path));
  const rewritten = text.replace(
    /(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g,
    (_match, prefix, relative, suffix) =>
      `${prefix}${pathToFileURL(resolve(root, relative)).href}${suffix}`,
  );
  return import(
    `data:text/javascript;base64,${Buffer.from(rewritten).toString("base64")}`
  );
}
const oldService = (await priorModule("scripts/automation/service.mjs"))
  .createAutomationService;
const oldFacade = (
  await priorModule("src/features/bosses/BossBattle/boss-battle-remote.js")
).createRemoteBattleSession;
const vite = await createServer({
  configFile: false,
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
const { BossBattlePanel } = await vite.ssrLoadModule(
  "/src/features/bosses/BossBattle/BossBattlePanel.jsx",
);
const oldWindow = globalThis.window;
globalThis.window = {
  matchMedia: () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }),
  addEventListener() {},
  removeEventListener() {},
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return [
    sorted[Math.ceil(sorted.length * 0.5) - 1],
    sorted[Math.ceil(sorted.length * 0.95) - 1],
    sorted.at(-1),
  ].map((n) => +n.toFixed(2));
};
let sampleId = 0;
async function sample(serviceFactory, facadeFactory) {
  const id = ++sampleId;
  const directory = mkdtempSync(join(tmpdir(), "action-end-to-end-"));
  const store = createAutomationStateStore({ directory });
  const credential = `Bearer fake.benchmark${id}.signature`;
  const startTime = Date.now();
  const initial = {
    battleId: "active-1",
    bossId: 7,
    status: "active",
    serverTimeUtc: new Date(startTime).toISOString(),
    cooldownUntilUtc: new Date(startTime).toISOString(),
    expiresAtUtc: new Date(startTime + 120000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 80,
    playerMaxHealth: 100,
    bossHealth: 100,
    bossMaxHealth: 100,
    myDamage: 0,
    participants: [{ playerId: 101, nickname: "Player" }],
    actions: [],
    reward: { drops: [] },
  };
  let current = initial;
  let clickedAt,
    acceptedAt,
    dispatchAt,
    confirmedAt,
    renderedAt,
    calls = 0,
    mutations = 0;
  const fetcher = async (input, init = {}) => {
    const path = new URL(input).pathname;
    const method = init.method || "GET";
    if (clickedAt !== undefined) calls++;
    if (path === "/api/me")
      return Response.json({ playerId: 101, nickname: "Player" });
    if (path === "/api/me/bag")
      return Response.json({ activityItems: [], consumables: [] });
    if (path === "/api/clothing/by-category/1")
      return Response.json({ success: true, items: [] });
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/bosses/7")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: current,
        state: { canStartFight: false },
      });
    if (path === "/api/bosses/battles/active-1" && method === "GET")
      return Response.json(current);
    if (path === "/api/bosses/battles/active-1/attack" && method === "POST") {
      dispatchAt = performance.now();
      mutations++;
      current = { ...initial, bossHealth: 70, myDamage: 30 };
      confirmedAt = performance.now();
      return Response.json({ battle: current });
    }
    throw Error(`unexpected fake request ${method} ${path}`);
  };
  const service = serviceFactory({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 101, nickname: "Player" }),
    getBoss: (bossId) => ({
      numericId: bossId,
      name: "Boss",
      possibleDrops: [],
    }),
    random: () => 0,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });
  let session, renderer;
  try {
    const entry = await service.identify(credential);
    await entry.controller.open({ numericId: 7, name: "Boss" });
    await service.boot();
    const request = async (method, path, command) => {
      if (method === "GET") return service.snapshot(entry);
      assert.equal(path, "/api/automation/commands");
      const result = await service.command(entry, command);
      const saved = store.read("101");
      assert.ok(saved.queuedActions.some((job) => job.id === command.id));
      acceptedAt = performance.now();
      return result;
    };
    session = facadeFactory({
      request,
      makeId: () => `benchmark-attack-${id}`,
    });
    await session.connect();
    let resolveMounted, resolveRendered;
    const mounted = new Promise((done) => {
      resolveMounted = done;
    });
    const rendered = new Promise((done) => {
      resolveRendered = done;
    });
    function View() {
      const snapshot = useSyncExternalStore(
        session.bossBattle.subscribe,
        session.bossBattle.getSnapshot,
      );
      useLayoutEffect(() => {
        resolveMounted();
        if (
          snapshot.battle?.bossHealth === 70 &&
          confirmedAt !== undefined &&
          renderedAt === undefined
        ) {
          renderedAt = performance.now();
          resolveRendered();
        }
      }, [snapshot]);
      return React.createElement(BossBattlePanel, {
        state: snapshot,
        now: Date.now(),
        onAttack: () => void session.bossBattle.attack(),
      });
    }
    renderer = create(React.createElement(View));
    await mounted;
    const button = renderer.root
      .findAllByType("button")
      .find((node) =>
        node
          .findAllByType("span")
          .some((span) => span.children.includes("Ударить")),
      );
    assert.ok(button);
    clickedAt = performance.now();
    button.props.onClick();
    await Promise.race([
      rendered,
      sleep(8000).then(() => {
        throw Error("timed out waiting for real actor and panel");
      }),
    ]);
    assert.equal(mutations, 1);
    assert.equal(store.read("101").queuedActions[0].status, "completed");
    assert.equal(
      renderer.root.findAllByProps({ "aria-label": "Здоровье: Босс" })[0].props[
        "aria-valuenow"
      ],
      70,
    );
    return {
      clickAccepted: acceptedAt - clickedAt,
      acceptedDispatch: dispatchAt - acceptedAt,
      confirmedRendered: renderedAt - confirmedAt,
      clickRendered: renderedAt - clickedAt,
      calls,
      mutations,
    };
  } finally {
    renderer?.unmount();
    session?.disconnect();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
try {
  for (const [label, serviceFactory, facadeFactory] of [
    ["before", oldService, oldFacade],
    ["after", createAutomationService, createRemoteBattleSession],
  ]) {
    const rows = await Promise.all(
      Array.from({ length: 20 }, () => sample(serviceFactory, facadeFactory)),
    );
    process.stdout.write(
      `${JSON.stringify({ label, n: rows.length, clickAccepted: stats(rows.map((x) => x.clickAccepted)), acceptedDispatch: stats(rows.map((x) => x.acceptedDispatch)), confirmedRendered: stats(rows.map((x) => x.confirmedRendered)), clickRendered: stats(rows.map((x) => x.clickRendered)), calls: stats(rows.map((x) => x.calls)), mutations: stats(rows.map((x) => x.mutations)) })}\n`,
    );
  }
} finally {
  globalThis.window = oldWindow;
  await vite.close();
}
