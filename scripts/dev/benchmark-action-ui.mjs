import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import React, { useLayoutEffect, useSyncExternalStore } from "react";
import { create } from "react-test-renderer";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createAutomationStateStore } from "../automation/state-store.mjs";
import { createRemoteBattleSession } from "../../src/features/bosses/BossBattle/boss-battle-remote.js";

// Compare the original and current client facade with the same production panel,
// a durable local fake server, and one fake game confirmation per click.
const prior = execFileSync(
  "git",
  ["show", "fadb7693:src/features/bosses/BossBattle/boss-battle-remote.js"],
  { encoding: "utf8" },
)
  .replace(
    '"./boss-battle-reference.js"',
    JSON.stringify(
      pathToFileURL(
        resolve("src/features/bosses/BossBattle/boss-battle-reference.js"),
      ).href,
    ),
  )
  .replace(
    '"../../../../shared/auth-session.js"',
    JSON.stringify(pathToFileURL(resolve("shared/auth-session.js")).href),
  );
const oldFacade = (
  await import(
    `data:text/javascript;base64,${Buffer.from(prior).toString("base64")}`
  )
).createRemoteBattleSession;
const server = await createServer({
  configFile: false,
  plugins: [react()],
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
const { BossBattlePanel } = await server.ssrLoadModule(
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
const directory = mkdtempSync(join(tmpdir(), "action-ui-bench-"));
const store = createAutomationStateStore({ directory });
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return [
    sorted[Math.ceil(sorted.length * 0.5) - 1],
    sorted[Math.ceil(sorted.length * 0.95) - 1],
    sorted.at(-1),
  ].map((n) => +n.toFixed(2));
};
let nextPlayer = 10000;
async function sample(factory) {
  const playerId = ++nextPlayer;
  const battle = {
    id: "battle-1",
    status: "active",
    bossHealth: 100,
    bossMaxHealth: 100,
    playerHealth: 100,
    playerMaxHealth: 100,
    readyAt: 0,
    expiresAt: null,
    events: [],
  };
  let state = {
    version: 1,
    queuedActions: [],
    battle: { boss: { id: 7, name: "Boss", reference: {} }, battle },
    auto: { enabled: false, pause: false },
  };
  let startedAt,
    acceptedAt,
    confirmedAt,
    renderedAt,
    fakeMutations = 0;
  let resolveMounted;
  const mounted = new Promise((resolveDone) => {
    resolveMounted = resolveDone;
  });
  let resolveRendered;
  const rendered = new Promise((resolveDone) => {
    resolveRendered = resolveDone;
  });
  const request = async (method, path, command) => {
    if (method === "GET") return structuredClone(state);
    assert.equal(path, "/api/automation/commands");
    assert.equal(command.args.type, "battle.attack");
    const queued = {
      id: command.id,
      type: "battle.attack",
      args: command.args.action,
      status: "queued",
      priority: 50,
    };
    state = {
      ...state,
      version: 2,
      queuedActions: [queued],
      enqueuedJobId: command.id,
    };
    store.write(playerId, state);
    acceptedAt = performance.now();
    assert.equal(store.read(playerId).queuedActions[0].id, command.id);
    const accepted = structuredClone(state);
    setTimeout(() => {
      fakeMutations++;
      state = {
        ...state,
        version: 3,
        queuedActions: [{ ...queued, status: "completed" }],
        battle: {
          ...state.battle,
          battle: { ...battle, bossHealth: 70, totalDamage: 30 },
        },
      };
      store.write(playerId, state);
      confirmedAt = performance.now();
    }, 0);
    return accepted;
  };
  const session = factory({ request, makeId: () => `benchmark-${playerId}` });
  await session.connect();
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
  const renderer = create(React.createElement(View));
  await mounted;
  const button = renderer.root
    .findAllByType("button")
    .find((node) =>
      node
        .findAllByType("span")
        .some((span) => span.children.includes("Ударить")),
    );
  assert.ok(button);
  startedAt = performance.now();
  button.props.onClick();
  await Promise.race([
    rendered,
    sleep(5000).then(() => {
      throw Error("timed out waiting for confirmed panel update");
    }),
  ]);
  assert.equal(fakeMutations, 1);
  assert.equal(store.read(playerId).battle.battle.bossHealth, 70);
  assert.equal(
    renderer.root.findAllByProps({ "aria-label": "Здоровье: Босс" })[0].props[
      "aria-valuenow"
    ],
    70,
  );
  const result = {
    clickAccepted: acceptedAt - startedAt,
    confirmRendered: renderedAt - confirmedAt,
    fakeMutations,
  };
  renderer.unmount();
  session.disconnect();
  return result;
}
try {
  for (const [label, facade] of [
    ["before", oldFacade],
    ["after", createRemoteBattleSession],
  ]) {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => sample(facade)),
    );
    process.stdout.write(
      `${JSON.stringify({ label, n: results.length, clickAccepted: stats(results.map((x) => x.clickAccepted)), confirmRendered: stats(results.map((x) => x.confirmRendered)), fakeMutations: results.reduce((sum, x) => sum + x.fakeMutations, 0) })}\n`,
    );
  }
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
  globalThis.window = oldWindow;
  await server.close();
}
