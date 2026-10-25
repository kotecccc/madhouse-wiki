import test from "node:test";
import assert from "node:assert/strict";
import {
  isActiveBattle,
  activeBattleEntries,
  normalizePvpBattle,
  createPvpBattleObserver,
} from "../src/features/combat/ActiveBattleDock/active-battle-state.js";
const active = { id: "battle-1", status: "active", expiresAt: null };
const raw = {
  battleId: "pvp-1",
  status: "active",
  playerHealth: 50,
  opponentHealth: 60,
};

test("indicator is absent for preparation, failures, terminal and expired battles", () => {
  assert.deepEqual(
    activeBattleEntries(
      { boss: { name: "Босс" }, battle: null, needsRefresh: true },
      { battle: null },
    ),
    [],
  );
  for (const status of ["won", "lost", "expired", "surrendered", "unknown", ""])
    assert.equal(isActiveBattle({ ...active, status }), false);
  assert.equal(isActiveBattle({ ...active, expiresAt: 1000 }, 1000), false);
  assert.equal(isActiveBattle({ ...active, expiresAt: 1001 }, 1000), true);
  assert.equal(isActiveBattle(null), false);
  assert.equal(isActiveBattle({ status: "active" }), false);
});

test("boss and PvP produce separate entries and pending launch alone is not active", () => {
  const boss = { boss: { name: "Босс" }, battle: active };
  assert.deepEqual(
    activeBattleEntries(boss, { battle: { ...active, id: "pvp-1" } }).map(
      (e) => e.kind,
    ),
    ["boss", "pvp"],
  );
  assert.equal(
    activeBattleEntries(
      { boss: { name: "Босс" }, pending: "start" },
      { battle: null },
    ).length,
    0,
  );
  assert.equal(
    activeBattleEntries(
      {
        ...boss,
        battle: { ...active, status: "won" },
        purchaseUncertain: true,
      },
      { battle: null },
    ).length,
    0,
  );
});

test("PvP observer verifies detail and keeps no identities or wallet", async () => {
  const calls = [];
  const observer = createPvpBattleObserver({
    request: async (path) => {
      calls.push(path);
      return path === "/api/combat"
        ? { activeBattle: { battleId: "pvp-1" } }
        : { ...raw, player: { nickname: "private" }, reward: { gold: 99 } };
    },
  });
  assert.equal(calls.length, 0);
  await observer.refresh();
  assert.deepEqual(calls, ["/api/combat", "/api/combat/battles/pvp-1"]);
  assert.equal(isActiveBattle(observer.getSnapshot().battle), true);
  assert.equal(
    JSON.stringify(observer.getSnapshot()).includes("private"),
    false,
  );
  assert.equal("reward" in observer.getSnapshot().battle, false);
});

test("unknown activeBattle shape or null never creates an indicator", async () => {
  for (const activeBattle of [
    null,
    {},
    { id: "undocumented" },
    { battleId: "../invalid" },
  ]) {
    let calls = 0;
    const observer = createPvpBattleObserver({
      request: async () => {
        calls++;
        return { activeBattle };
      },
    });
    await observer.refresh();
    assert.equal(calls, 1);
    assert.equal(observer.getSnapshot().battle, null);
  }
});

test("mismatched or unavailable PvP details cannot leave a stale active indicator", async () => {
  let fail = false;
  const observer = createPvpBattleObserver({
    request: async (path) => {
      if (path === "/api/combat")
        return { activeBattle: { battleId: "pvp-1" } };
      return fail ? { ...raw, battleId: "another" } : raw;
    },
  });
  await observer.refresh();
  fail = true;
  await observer.refresh();
  assert.equal(observer.getSnapshot().battle, null);
  assert.equal(observer.getSnapshot().error, true);
});

test("refresh learns that a battle ended; server clock anchors expiry", async () => {
  let status = "active";
  const observer = createPvpBattleObserver({
    request: async (path) =>
      path === "/api/combat"
        ? { activeBattle: { battleId: "pvp-1" } }
        : { ...raw, status },
  });
  await observer.refresh();
  status = "won";
  await observer.refresh();
  assert.equal(isActiveBattle(observer.getSnapshot().battle), false);
  const battle = normalizePvpBattle(
    {
      ...raw,
      serverTimeUtc: "2026-10-24T10:00:00Z",
      expiresAtUtc: "2026-10-24T10:00:05Z",
    },
    "pvp-1",
    1000,
  );
  assert.equal(battle.expiresAt, 6000);
  assert.equal(isActiveBattle(battle, 6000), false);
});

test("session reset aborts pending discovery and prevents further detail reads", async () => {
  let finish;
  let signal;
  let calls = 0;
  const observer = createPvpBattleObserver({
    request: async (_path, options) => {
      calls++;
      signal = options.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = observer.refresh();
  await observer.refresh();
  assert.equal(calls, 1);
  observer.reset();
  assert.equal(signal.aborted, true);
  finish({ activeBattle: { battleId: "pvp-1" } });
  await pending;
  assert.equal(calls, 1);
  assert.equal(observer.getSnapshot().battle, null);
  assert.equal(observer.getSnapshot().pending, false);
});

test("manually discovered boss remains in the dock after closing, until a confirmed outcome", async () => {
  const { createBossBattleController } =
    await import("../src/features/bosses/BossBattle/boss-battle-controller.js");
  const store = createBossBattleController({
    request: async () => ({
      id: 7,
      activeBattle: {
        battleId: "manual-fight",
        bossId: 7,
        status: "active",
        expiresAtUtc: "2020-01-01T00:00:00Z",
      },
    }),
  });
  store.open({ numericId: 7, name: "Босс" });
  await new Promise((r) => setImmediate(r));
  store.close();
  assert.equal(store.getSnapshot().visible, false);
  assert.equal(
    activeBattleEntries(store.getSnapshot(), { battle: null }).length,
    1,
  );
  store.syncExternalBattle(
    { numericId: 7, name: "Босс" },
    { battleId: "manual-fight", bossId: 7, status: "won" },
    store.getSnapshot(),
  );
  assert.equal(
    activeBattleEntries(store.getSnapshot(), { battle: null }).length,
    0,
  );
});

test("boss dock remains available to stop a series between fights and during its next start", () => {
  for (const battle of [{ ...active, status: "won" }, null]) {
    const entries = activeBattleEntries(
      { boss: { name: "Босс" }, battle, pending: battle ? null : "restart" },
      { battle: null },
      Date.now(),
      { enabled: true },
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "boss");
  }
});

test("raid indicator remains visible while waiting for a battle", () => {
  const entries = activeBattleEntries(
    {
      boss: { id: 7, name: "Босс" },
      battle: null,
      raid: { enabled: true, status: "waiting", bossId: 7 },
    },
    { battle: null },
    1000,
    { enabled: false },
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "boss");
});
