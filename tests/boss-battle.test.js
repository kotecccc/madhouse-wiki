import test from "node:test";
import assert from "node:assert/strict";
import {
  createBossBattleController,
  canAttackBattle,
  normalizeBattle,
} from "../src/features/bosses/BossBattle/boss-battle-controller.js";
import { createBossBattleRequest } from "../src/features/bosses/BossBattle/boss-battle-session.js";

const boss = { numericId: 7, name: "Тестовый босс" };
const rawBattle = (patch = {}) => ({
  battleId: "battle-1",
  bossId: 7,
  status: "active",
  playerHealth: 100,
  playerMaxHealth: 100,
  bossHealth: 200,
  bossMaxHealth: 200,
  ...patch,
});
const detail = (patch = {}) => ({
  id: 7,
  state: { canStartFight: true },
  activeBattle: null,
  ...patch,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));
function setup(handler) {
  const calls = [];
  const store = createBossBattleController({
    request: async (...args) => {
      calls.push(args);
      return handler(...args);
    },
    operationId: () => "test-operation",
  });
  return { store, calls };
}

test("opening only reads; attack applies its reply without a second GET and duplicate clicks send once", async () => {
  let release;
  let hits = 0;
  const { store, calls } = setup(async (method, path) => {
    if (path === "/api/bosses/7") return detail();
    if (method === "GET") return rawBattle({ bossHealth: hits ? 150 : 200 });
    if (path.endsWith("/attack")) {
      hits++;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return { battle: rawBattle({ bossHealth: hits ? 150 : 200 }) };
  });
  assert.equal(calls.length, 0);
  store.open(boss);
  await settle();
  assert.equal(calls.length, 1);
  await store.start();
  const readsBeforeAttack = calls.filter(([method]) => method === "GET").length;
  const attack = store.attack();
  await store.attack();
  assert.equal(
    calls.filter(([m, p]) => m === "POST" && p.endsWith("attack")).length,
    1,
  );
  release();
  await attack;
  assert.equal(
    calls.filter(([method]) => method === "GET").length,
    readsBeforeAttack,
  );
  assert.equal(store.getSnapshot().battle.bossHealth, 150);
  assert.equal(store.getSnapshot().needsRefresh, false);
  assert.deepEqual(
    calls.filter(([m]) => m === "POST").map((c) => c[2]),
    [{ operationId: "test-operation" }, { operationId: "test-operation" }],
  );
});

test("existing battle is resumed without a start; close retains it and reopen refreshes", async () => {
  const { store, calls } = setup((_method, path) =>
    path.includes("/battles/")
      ? rawBattle()
      : detail({ activeBattle: rawBattle() }),
  );
  store.open(boss);
  await settle();
  store.close();
  assert.equal(store.getSnapshot().battle.id, "battle-1");
  store.open({ numericId: 8, name: "Другой босс" });
  await settle();
  assert.equal(store.getSnapshot().boss.id, 7);
  assert.equal(store.getSnapshot().needsRefresh, false);
  assert.equal(calls.at(-1)[1], "/api/bosses/battles/battle-1");
  assert.equal(
    calls.every(([m]) => m === "GET"),
    true,
  );
});

test("lost mutation response blocks further attacks and never retries POST", async () => {
  const { store, calls } = setup((method) => {
    if (method === "POST") throw new Error("timeout");
    return detail({ activeBattle: rawBattle() });
  });
  store.open(boss);
  await settle();
  await store.attack();
  await store.attack();
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.equal(calls.filter(([m]) => m === "POST").length, 1);
});

test("failed start can discover the already-created battle without another POST", async () => {
  let started = false;
  const { store, calls } = setup((method) => {
    if (method === "POST") {
      started = true;
      throw new Error("lost reply");
    }
    return detail({ activeBattle: started ? rawBattle() : null });
  });
  store.open(boss);
  await settle();
  await store.start();
  await store.start();
  await store.refresh();
  assert.equal(store.getSnapshot().battle.id, "battle-1");
  assert.equal(calls.filter(([m]) => m === "POST").length, 1);
});

test("session reset discards late responses and aborts the request", async () => {
  let resolve;
  let signal;
  const { store } = setup((_method, _path, _body, options) => {
    signal = options.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  store.open(boss);
  store.reset();
  assert.equal(signal.aborted, true);
  resolve(detail({ activeBattle: rawBattle() }));
  await settle();
  assert.equal(store.getSnapshot().boss, null);
  assert.equal(store.getSnapshot().battle, null);
});

test("server clock anchors cooldown; missing health, expiry and unknown statuses block attacks", () => {
  const battle = normalizeBattle(
    rawBattle({
      serverTimeUtc: "2026-10-24T10:00:00Z",
      cooldownUntilUtc: "2026-10-24T10:00:03Z",
      retryAfterMilliseconds: 500,
    }),
    7,
    1000,
  );
  const state = { battle };
  assert.equal(canAttackBattle(state, 3999), false);
  assert.equal(canAttackBattle(state, 4000), true);
  for (const patch of [
    { status: "unexpected" },
    { status: "won" },
    { playerHealth: 0 },
    { playerHealth: null },
    { expiresAt: 3500 },
  ])
    assert.equal(
      canAttackBattle({ battle: { ...battle, ...patch } }, 4000),
      false,
    );
});

test("partial boss responses and mismatched battle identity never unlock mutation", async () => {
  const { store } = setup(() => ({ id: 7 }));
  store.open(boss);
  await settle();
  assert.equal(store.getSnapshot().canStart, false);
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.throws(() => normalizeBattle(rawBattle({ bossId: 8 }), 7));
});

test("results project granted rewards and documented battle stats without private fields", () => {
  const b = normalizeBattle(
    rawBattle({
      status: "won",
      myDamage: 57,
      participantCount: 1,
      actions: [
        {
          itemType: null,
          playerDamage: 30,
          playerId: 41,
          turn: 1,
          critical: false,
        },
        {
          itemType: "medicine",
          playerDamage: 0,
          playerId: 41,
          turn: 2,
          healthRestored: 10,
        },
        {
          itemType: null,
          playerDamage: 27,
          operationId: "private-op",
          turn: 3,
        },
      ],
      participants: [
        {
          nickname: "Игрок",
          role: "leader",
          status: "active",
          level: 12,
          health: 80,
          maxHealth: 100,
          damageDealt: 57,
          playerId: 41,
          username: "private-user",
          avatarUrl: "https://private.invalid/avatar",
        },
      ],
      reward: {
        wallet: { gold: 999 },
        guaranteed: { gold: 10 },
        drops: [
          { name: "Предмет", amount: 2, granted: true },
          { name: "Не выдан", amount: 1, granted: false },
        ],
      },
    }),
    7,
  );
  assert.equal(b.outcome, "Победа");
  assert.deepEqual(b.rewards, ["Золото: 10", "Предмет: 2"]);
  assert.equal(b.attackCount, null);
  assert.equal(b.totalDamage, 57);
  assert.equal(b.participantCount, 1);
  assert.deepEqual(b.events, [
    {
      turn: 3,
      at: null,
      actor: "Участник",
      damage: 27,
      critical: null,
      itemType: null,
      healthRestored: null,
    },
    {
      turn: 2,
      at: null,
      actor: "Игрок",
      damage: 0,
      critical: null,
      itemType: "medicine",
      healthRestored: 10,
    },
    {
      turn: 1,
      at: null,
      actor: "Игрок",
      damage: 30,
      critical: false,
      itemType: null,
      healthRestored: null,
    },
  ]);
  assert.deepEqual(b.participants, [
    {
      nickname: "Игрок",
      role: "leader",
      status: "active",
      level: 12,
      health: 80,
      maxHealth: 100,
      damageDealt: 57,
    },
  ]);
  const projected = JSON.stringify(b);
  for (const privateValue of [
    "private-user",
    "private-op",
    "private.invalid",
    "playerId",
    "operationId",
    "999",
  ])
    assert.equal(projected.includes(privateValue), false);
});

test("battle stats stay unavailable when the documented source fields are absent or malformed", () => {
  const b = normalizeBattle(
    rawBattle({ actions: "unknown", myDamage: "57", participants: [null, 7] }),
    7,
  );
  assert.equal(b.attackCount, null);
  assert.equal(b.totalDamage, null);
  assert.equal(b.participantCount, null);
  assert.deepEqual(b.participants, []);
  assert.deepEqual(b.events, []);
});

test("transport uses guarded same-origin requests, rejects unrelated routes and never retries failures", async () => {
  const calls = [];
  const request = createBossBattleRequest({
    authorize: (r) => ({ ...r, headers: { Authorization: "test-only" } }),
    fetcher: async (...args) => {
      calls.push(args);
      return { ok: false, status: 500 };
    },
  });
  await assert.rejects(
    request("POST", "/api/bosses/7/battles", { operationId: "test" }),
    { status: 500 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].headers["X-Madhouse-Allow-Mutations"], "true");
  await assert.rejects(request("POST", "/api/bank/purchases", {}));
  await assert.rejects(request("GET", "https://example.com/api/bosses/7"));
  assert.equal(calls.length, 1);
});

test("reconciliation never shortens the cooldown returned by the mutation", async () => {
  const { store } = setup((method, path) => {
    if (path === "/api/bosses/7") return detail();
    if (method === "POST")
      return { battle: rawBattle({ retryAfterMilliseconds: 10000 }) };
    return rawBattle({ cooldownUntilUtc: null, retryAfterMilliseconds: 0 });
  });
  store.open(boss);
  await settle();
  await store.start();
  assert.equal(canAttackBattle(store.getSnapshot(), Date.now()), false);
});

test("transport never fetches when authorization fails, and rejects path traversal", async () => {
  let fetched = false;
  const request = createBossBattleRequest({
    authorize: () => {
      throw new Error("not signed in");
    },
    fetcher: async () => {
      fetched = true;
    },
  });
  await assert.rejects(request("POST", "/api/bosses/7/battles", {}));
  await assert.rejects(request("GET", "/api/bosses/battles/.."));
  assert.equal(fetched, false);
  assert.throws(() => normalizeBattle(rawBattle({ battleId: ".." }), 7));
});

test("upstream failure keeps start blocked and retains only the safe HTTP status", async () => {
  const { store, calls } = setup(() => {
    const error = new Error("private upstream details");
    error.status = 500;
    throw error;
  });
  store.open(boss);
  await settle();
  assert.equal(store.getSnapshot().errorStatus, 500);
  assert.equal(store.getSnapshot().canStart, false);
  assert.equal(store.getSnapshot().needsRefresh, true);
  await store.start();
  assert.equal(
    calls.some(([method]) => method === "POST"),
    false,
  );
  assert.equal(
    JSON.stringify(store.getSnapshot()).includes("private upstream details"),
    false,
  );
});

test("partial attack reply preserves confirmed participants and journal without another GET", async () => {
  const initial = rawBattle({
    participantCount: 1,
    myDamage: 20,
    participants: [{ playerId: 42, nickname: "Игрок", damageDealt: 20 }],
    actions: [{ turn: 1, playerId: 42, playerDamage: 20 }],
  });
  const { store, calls } = setup((method) =>
    method === "GET"
      ? detail({ activeBattle: initial })
      : { battle: rawBattle({ bossHealth: 150 }) },
  );
  store.open(boss);
  await settle();
  const before = store.getSnapshot().battle;
  await store.attack();
  const after = store.getSnapshot().battle;
  assert.equal(after.participantCount, before.participantCount);
  assert.equal(after.participants[0].nickname, before.participants[0].nickname);
  assert.equal(after.participants[0].damageDealt, null);
  assert.equal(after.participantsStale, true);
  assert.equal(after.events.length, before.events.length + 1);
  assert.equal(after.events[0].confirmed, true);
  assert.equal(after.events[1], before.events[0]);
  assert.equal(after.participantCount, 1);
  assert.equal(after.bossHealth, 150);
  assert.equal(after.totalDamage, 20);
  assert.equal(store.getSnapshot().needsRefresh, false);
  assert.equal(calls.length, 2);
});

test("attack journal adds a new event without dropping existing history", async () => {
  const { store, calls } = setup((method) =>
    method === "GET"
      ? detail({
          activeBattle: rawBattle({ actions: [{ turn: 1, playerDamage: 20 }] }),
        })
      : { battle: rawBattle({ actions: [{ turn: 2, playerDamage: 30 }] }) },
  );
  store.open(boss);
  await settle();
  const oldEvent = store.getSnapshot().battle.events[0];
  await store.attack();
  assert.deepEqual(
    store.getSnapshot().battle.events.map((e) => e.turn),
    [2, 1],
  );
  assert.equal(store.getSnapshot().battle.events[1], oldEvent);
  assert.equal(calls.length, 2);
});

test("incomplete strike reply requires manual refresh and does not trigger automatic reconciliation", async () => {
  const { store, calls } = setup((method) =>
    method === "GET"
      ? detail({ activeBattle: rawBattle() })
      : { battle: { battleId: "battle-1", bossId: 7, bossHealth: 150 } },
  );
  store.open(boss);
  await settle();
  await store.attack();
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.equal(store.getSnapshot().battle.bossHealth, 150);
  assert.equal(canAttackBattle(store.getSnapshot()), false);
  assert.equal(calls.length, 2);
});

test("a confirmed hit adds a local event while preserving existing participant labels", async () => {
  const actions = [{ turn: 1, playerId: 42, playerDamage: 20 }];
  const { store } = setup((method) =>
    method === "GET"
      ? detail({
          activeBattle: rawBattle({
            actions,
            participants: [{ playerId: 42, nickname: "Игрок" }],
          }),
        })
      : { battle: rawBattle({ actions }) },
  );
  store.open(boss);
  await settle();
  const before = store.getSnapshot().battle.events;
  await store.attack();
  assert.equal(store.getSnapshot().battle.events.length, before.length + 1);
  assert.equal(store.getSnapshot().battle.events[0].confirmed, true);
  assert.equal(store.getSnapshot().battle.events[1], before[0]);
  assert.equal(store.getSnapshot().battle.events[1].actor, "Игрок");
});

test("victory starts the next fight only after an explicit click and fresh preflight", async () => {
  let reads = 0;
  const { store, calls } = setup((method, path) => {
    if (path === "/api/bosses/7")
      return ++reads === 1
        ? detail({ activeBattle: rawBattle({ status: "won" }) })
        : detail();
    if (method === "POST")
      return { battle: rawBattle({ battleId: "battle-2" }) };
    return rawBattle({ battleId: "battle-2" });
  });
  store.open(boss);
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(store.getSnapshot().battle.status, "won");
  await store.startNextBattle();
  assert.equal(store.getSnapshot().battle.id, "battle-2");
  assert.deepEqual(
    calls.map(([m, p]) => [m, p]),
    [
      ["GET", "/api/bosses/7"],
      ["GET", "/api/bosses/7"],
      ["POST", "/api/bosses/7/battles"],
      ["GET", "/api/bosses/battles/battle-2"],
    ],
  );
  assert.equal(
    calls.some(([, p]) => p.endsWith("/attack")),
    false,
  );
});

test("next-fight preflight resumes an existing fight instead of starting another", async () => {
  let reads = 0;
  const { store, calls } = setup(() =>
    detail({
      activeBattle: rawBattle(
        ++reads === 1 ? { status: "won" } : { battleId: "external-battle" },
      ),
    }),
  );
  store.open(boss);
  await settle();
  await store.startNextBattle();
  assert.equal(store.getSnapshot().battle.id, "external-battle");
  assert.equal(
    calls.every(([m]) => m === "GET"),
    true,
  );
});

test("next-fight action keeps the victory result when the server disallows a start", async () => {
  let reads = 0;
  const { store, calls } = setup(() =>
    ++reads === 1
      ? detail({ activeBattle: rawBattle({ status: "won" }) })
      : detail({ state: { canStartFight: false } }),
  );
  store.open(boss);
  await settle();
  await store.startNextBattle();
  assert.equal(store.getSnapshot().battle.status, "won");
  assert.equal(
    calls.every(([m]) => m === "GET"),
    true,
  );
  assert.match(store.getSnapshot().notice, /нельзя/);
});

test("lost next-fight response never retries a POST and manual refresh discovers the new battle", async () => {
  let reads = 0;
  let started = false;
  const { store, calls } = setup((method) => {
    if (method === "POST") {
      started = true;
      throw new Error("lost response");
    }
    if (++reads === 1)
      return detail({ activeBattle: rawBattle({ status: "won" }) });
    return detail({
      activeBattle: started ? rawBattle({ battleId: "battle-2" }) : null,
    });
  });
  store.open(boss);
  await settle();
  await store.startNextBattle();
  await store.startNextBattle();
  assert.equal(calls.filter(([m]) => m === "POST").length, 1);
  assert.equal(store.getSnapshot().needsRefresh, true);
  await store.refresh();
  assert.equal(store.getSnapshot().battle.id, "battle-2");
});

test("duplicate next-fight clicks share one pending action", async () => {
  let reads = 0;
  let release;
  const { store, calls } = setup(async (method, path) => {
    if (path === "/api/bosses/7") {
      if (++reads === 1)
        return detail({ activeBattle: rawBattle({ status: "won" }) });
      await new Promise((resolve) => {
        release = resolve;
      });
      return detail();
    }
    if (method === "POST")
      return { battle: rawBattle({ battleId: "battle-2" }) };
    return rawBattle({ battleId: "battle-2" });
  });
  store.open(boss);
  await settle();
  const first = store.startNextBattle();
  await store.startNextBattle();
  assert.equal(reads, 2);
  release();
  await first;
  assert.equal(calls.filter(([m]) => m === "POST").length, 1);
});

test("auto cooldown requires explicit server timing metadata for each reply", () => {
  assert.equal(normalizeBattle(rawBattle(), 7, 1000).cooldownKnown, false);
  assert.equal(
    normalizeBattle(rawBattle({ retryAfterMilliseconds: 0 }), 7, 1000)
      .cooldownKnown,
    true,
  );
  assert.equal(
    normalizeBattle(rawBattle({ retryAfterMilliseconds: 3000 }), 7, 1000)
      .readyAt,
    4000,
  );
  assert.equal(
    normalizeBattle(
      rawBattle({
        cooldownUntilUtc: "2026-10-24T10:00:03Z",
        serverTimeUtc: "2026-10-24T10:00:00Z",
      }),
      7,
      1000,
    ).readyAt,
    4000,
  );
});

test("confirmed hits update the journal and damage from attributed response hits without another GET", async () => {
  const { store, calls } = setup((method) =>
    method === "GET"
      ? detail({ activeBattle: rawBattle({ myDamage: 20 }) })
      : {
          battle: rawBattle({ bossHealth: 170, turn: 2 }),
          hits: [
            { actor: "player", damage: 30, critical: true },
            { actor: "boss", damage: 2 },
          ],
        },
  );
  store.open(boss);
  await settle();
  await store.attack();
  assert.equal(store.getSnapshot().battle.totalDamage, 50);
  assert.equal(store.getSnapshot().battle.events[0].damage, 30);
  assert.equal(store.getSnapshot().battle.events[0].critical, true);
  assert.equal(calls.length, 2);
});

test("local confirmed attack events use the current nickname without a profile request", async () => {
  const calls = [];
  const store = createBossBattleController({
    getPlayerIdentity: () => ({ nickname: "[PSY_A]koteccc" }),
    request: async (method, path) => {
      calls.push([method, path]);
      return method === "GET"
        ? detail({ activeBattle: rawBattle() })
        : {
            battle: rawBattle({ bossHealth: 150 }),
            hits: [{ actor: "player", damage: 50 }],
          };
    },
  });
  store.open(boss);
  await settle();
  await store.attack();
  assert.equal(store.getSnapshot().battle.events[0].actor, "[PSY_A]koteccc");
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some(([, path]) => path === "/api/me"),
    false,
  );
});

test("opening a summary battle loads full participant details once, never after each strike", async () => {
  const { store, calls } = setup((method, path) => {
    if (path === "/api/bosses/7")
      return detail({ activeBattle: rawBattle({ participants: [] }) });
    if (method === "GET")
      return rawBattle({
        participants: [{ nickname: "Игрок", damageDealt: 30 }],
      });
    return { battle: rawBattle({ bossHealth: 150 }) };
  });
  store.open(boss);
  await settle();
  assert.equal(store.getSnapshot().battle.detailsLoaded, false);
  await store.hydrateDetails();
  assert.equal(store.getSnapshot().battle.participantCount, 1);
  assert.equal(store.getSnapshot().battle.participants[0].nickname, "Игрок");
  await store.hydrateDetails();
  await store.attack();
  await store.hydrateDetails();
  assert.deepEqual(
    calls.map(([method]) => method),
    ["GET", "GET", "POST"],
  );
  assert.equal(store.getSnapshot().battle.detailsLoaded, true);
});

test("server actions can resolve the current nickname without retaining player identifiers", () => {
  const result = normalizeBattle(
    rawBattle({ actions: [{ turn: 1, playerId: 42, playerDamage: 20 }] }),
    7,
    1000,
    { playerId: 42, nickname: "[PSY_A]koteccc" },
  );
  assert.equal(result.events[0].actor, "[PSY_A]koteccc");
  assert.equal(JSON.stringify(result).includes("playerId"), false);
});

test("opening a different boss reconciles a restored terminal fight then selects the requested boss", async () => {
  const { store, calls } = setup((_method, path) =>
    path.includes("/battles/")
      ? rawBattle({ status: "won", bossHealth: 0 })
      : { id: 8, activeBattle: null, state: { canStartFight: true } },
  );
  store.restoreState({
    boss: { id: 7, name: "Old" },
    battle: normalizeBattle(rawBattle({ status: "won", bossHealth: 0 }), 7),
  });
  await store.open({ numericId: 8, name: "Selected" });
  assert.equal(store.getSnapshot().boss.id, 8);
  assert.equal(store.getSnapshot().battle, null);
  assert.equal(store.getSnapshot().canStart, true);
  assert.deepEqual(
    calls.map(([method, path]) => [method, path]),
    [
      ["GET", "/api/bosses/battles/battle-1"],
      ["GET", "/api/bosses/8"],
    ],
  );
});

test("failed reconciliation never discards an uncertain old fight for a new target", async () => {
  const { store, calls } = setup(() => {
    throw new Error("offline");
  });
  store.restoreState({
    boss: { id: 7, name: "Old" },
    battle: normalizeBattle(rawBattle(), 7),
  });
  await store.open({ numericId: 8, name: "Selected" });
  assert.equal(store.getSnapshot().boss.id, 7);
  assert.equal(store.getSnapshot().needsRefresh, true);
  assert.equal(calls.length, 1);
});
