import test from "node:test";
import assert from "node:assert/strict";
import {
  createBossBattleController,
  normalizeBattle,
} from "../src/features/bosses/BossBattle/boss-battle-controller.js";
import { createBossBattleRequest } from "../src/features/bosses/BossBattle/boss-battle-request.js";

const boss = { numericId: 7, name: "Тестовый босс" };
const battle = (patch = {}) => ({
  battleId: "battle-1",
  bossId: 7,
  status: "active",
  playerHealth: 100,
  playerMaxHealth: 100,
  bossHealth: 200,
  bossMaxHealth: 200,
  ...patch,
});
const summary = (patch = {}) => ({
  id: 7,
  state: { canStartFight: false },
  activeBattle: battle(),
  ...patch,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    body: { cancel: async () => {} },
  };
}

function adapter(fetcher) {
  return createBossBattleRequest({
    authorize: ({ url }) => ({ url, headers: {} }),
    fetcher,
  });
}

test("timed_out is normalized to the expired terminal result", () => {
  const normalized = normalizeBattle(
    battle({ status: " Timed_Out " }),
    7,
    1000,
  );
  assert.equal(normalized.status, "expired");
  assert.equal(normalized.outcome, "Время боя истекло");
});

for (const terminalStatus of ["lost", "timed_out"])
  for (const canStartFight of [true, false]) {
    test(`${terminalStatus} terminal summary allows manual restart only when canStartFight=${canStartFight}`, async () => {
      const calls = [];
      const request = async (method, path) => {
        calls.push([method, path]);
        if (path === "/api/bosses/7")
          return summary({
            state: { canStartFight },
            activeBattle: battle({
              status: terminalStatus,
              playerHealth: terminalStatus === "lost" ? 0 : 100,
            }),
          });
        if (method === "POST")
          return { battle: battle({ battleId: "battle-2" }) };
        return battle({ battleId: "battle-2" });
      };
      const store = createBossBattleController({
        request,
        operationId: () => "op-1",
      });
      store.open(boss);
      await tick();
      assert.equal(
        store.getSnapshot().battle.status,
        terminalStatus === "lost" ? "lost" : "expired",
      );
      await store.startNextBattle();
      assert.equal(
        calls.some(([method]) => method === "POST"),
        canStartFight,
      );
      if (canStartFight)
        assert.equal(store.getSnapshot().battle.id, "battle-2");
      else
        assert.equal(
          store.getSnapshot().battle.status,
          terminalStatus === "lost" ? "lost" : "expired",
        );
    });
  }

test("expired active detail reconciles to null summary and permits a fresh start", async () => {
  let summaryReads = 0;
  const calls = [];
  const request = async (method, path) => {
    calls.push([method, path]);
    if (path === "/api/bosses/7") {
      summaryReads++;
      return summaryReads === 1
        ? summary({ state: { canStartFight: false }, activeBattle: battle() })
        : summary({ state: { canStartFight: true }, activeBattle: null });
    }
    if (path === "/api/bosses/battles/battle-1")
      return battle({ expiresAtUtc: "2026-10-25T09:59:00.000Z" });
    if (method === "POST") return { battle: battle({ battleId: "battle-2" }) };
    return battle({ battleId: "battle-2" });
  };
  const store = createBossBattleController({
    request,
    now: () => Date.parse("2026-10-25T10:00:00.000Z"),
    operationId: () => "op-1",
  });
  store.open(boss);
  await tick();
  await store.refresh();
  assert.equal(store.getSnapshot().battle, null);
  assert.equal(store.getSnapshot().canStart, true);
  await store.start();
  assert.equal(store.getSnapshot().battle.id, "battle-2");
  assert.equal(calls.filter(([method]) => method === "POST").length, 1);
});

test("expired detail stays active when the fresh summary still reports an active fight", async () => {
  const request = async (_method, path) =>
    path === "/api/bosses/7"
      ? summary({ state: { canStartFight: false }, activeBattle: battle() })
      : battle({ expiresAtUtc: "2026-10-25T09:59:00.000Z" });
  const store = createBossBattleController({
    request,
    now: () => Date.parse("2026-10-25T10:00:00.000Z"),
  });
  store.open(boss);
  await tick();
  await store.refresh();
  assert.equal(store.getSnapshot().battle.status, "active");
  assert.equal(store.getSnapshot().canStart, false);
});

test("404 battle detail falls back to current boss summary", async () => {
  const calls = [];
  let summaryReads = 0;
  const request = async (method, path) => {
    calls.push([method, path]);
    if (path === "/api/bosses/7") {
      summaryReads++;
      return summaryReads === 1
        ? summary({ state: { canStartFight: false }, activeBattle: battle() })
        : summary({ state: { canStartFight: true }, activeBattle: null });
    }
    if (path === "/api/bosses/battles/battle-1") {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return summary({ state: { canStartFight: true }, activeBattle: null });
  };
  const store = createBossBattleController({ request });
  store.open(boss);
  await tick();
  await store.refresh();
  assert.equal(store.getSnapshot().battle, null);
  assert.equal(store.getSnapshot().canStart, true);
  assert.deepEqual(calls.slice(-2), [
    ["GET", "/api/bosses/battles/battle-1"],
    ["GET", "/api/bosses/7"],
  ]);
});

test("409 battle_finished with matching terminal battle reconciles without a strike event or retry", async () => {
  const calls = [];
  const request = adapter(async (url, init) => {
    calls.push([init.method, url]);
    if (init.method === "GET")
      return fakeResponse(200, summary({ activeBattle: battle() }));
    return fakeResponse(409, {
      error: "battle_finished",
      battle: battle({ status: "timed_out" }),
    });
  });
  const store = createBossBattleController({
    request,
    operationId: () => "op-1",
  });
  store.open(boss);
  await tick();
  await store.attack();
  const state = store.getSnapshot();
  assert.equal(state.battle.status, "expired");
  assert.equal(state.battle.outcome, "Время боя истекло");
  assert.deepEqual(state.battle.events, []);
  assert.equal(calls.filter(([method]) => method === "POST").length, 1);
  assert.equal(calls.filter(([method]) => method === "GET").length, 1);
});

test("409 battle_finished rejects a mismatched battle ID as uncertain", async () => {
  const request = adapter(async (_url, init) =>
    init.method === "GET"
      ? fakeResponse(200, summary({ activeBattle: battle() }))
      : fakeResponse(409, {
          error: "battle_finished",
          battle: battle({ battleId: "different-battle", status: "won" }),
        }),
  );
  const store = createBossBattleController({
    request,
    operationId: () => "op-1",
  });
  store.open(boss);
  await tick();
  await store.attack();
  assert.equal(store.getSnapshot().battle.id, "battle-1");
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.match(store.getSnapshot().error, /не подтверждён/i);
});

test("old saved timed_out checkpoint is displayed as terminal while awaiting verification", () => {
  const store = createBossBattleController({
    request: () => {
      throw Error("No request expected");
    },
  });
  store.restoreState({
    boss: { id: 7, name: "Boss" },
    battle: { id: "old-battle", status: "timed_out", outcome: null },
    pending: null,
  });
  assert.equal(store.getSnapshot().battle.status, "expired");
  assert.equal(store.getSnapshot().battle.outcome, "Время боя истекло");
  assert.equal(store.getSnapshot().needsRefresh, true);
});
