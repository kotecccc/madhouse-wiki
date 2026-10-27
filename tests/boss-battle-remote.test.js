import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteBattleSession } from "../src/features/bosses/BossBattle/boss-battle-remote.js";

function harness({ state, request: requestImpl, launchBattle } = {}) {
  let nowId = 0;
  let requestLog = [];
  let tasks = new Map();
  let taskId = 0;
  const requests = [];
  const schedule = (fn, delay) => {
    const id = ++taskId;
    tasks.set(id, { fn, delay });
    return id;
  };
  const cancel = (id) => tasks.delete(id);
  const request = async (...args) => {
    requestLog.push(args);
    requests.push(args);
    if (requestImpl) return requestImpl(...args);
    if (args[0] === "GET") return state ?? initialState();
    return { ...(state ?? initialState()), version: (state?.version ?? 0) + 1 };
  };
  const session = createRemoteBattleSession({
    request,
    launchBattle,
    schedule,
    cancel,
    makeId: () => `id-${++nowId}`,
  });
  return {
    ...session,
    requests,
    get calls() {
      return requestLog;
    },
    tasks,
    runTimer(id = tasks.keys().next().value) {
      const task = tasks.get(id);
      if (!task) return false;
      tasks.delete(id);
      task.fn();
      return true;
    },
  };
}

function initialState() {
  return {
    version: 7,
    battle: {
      boss: { id: 8, name: "Boss" },
      battle: { id: "b-1", status: "active" },
    },
    goal: null,
    auto: { enabled: false, nextAttackAt: null, pause: false },
    pvp: { battle: null, pending: false, error: null },
    preferences: { favoriteBossIds: [] },
  };
}

test("connect reads server state once, publishes stable snapshots, and polls locally", async () => {
  const h = harness();
  assert.equal(h.bossBattle.getSnapshot(), h.bossBattle.getSnapshot());
  await h.connect();
  assert.deepEqual(
    h.calls.map(([method, path]) => [method, path]),
    [["GET", "/api/automation/state"]],
  );
  assert.equal(h.bossBattle.getSnapshot().battle.id, "b-1");
  assert.equal(h.tasks.size, 1);
  assert.equal([...h.tasks.values()][0].delay, 180000);
  await h.connect();
  assert.equal(h.calls.length, 1);
});

test("raid subscription stays unavailable until server state has loaded", async () => {
  let resolveState;
  const h = harness({
    request: () => new Promise((resolve) => (resolveState = resolve)),
  });
  assert.equal(h.raidSubscriptions.getSnapshot().loaded, false);
  const connecting = h.connect();
  assert.equal(h.raidSubscriptions.getSnapshot().loaded, false);
  resolveState(initialState());
  await connecting;
  assert.equal(h.raidSubscriptions.getSnapshot().loaded, true);
  h.disconnect();
  assert.equal(h.raidSubscriptions.getSnapshot().loaded, false);
});

test("app launch passes the auth battle reference once per connection; polls stay local", async () => {
  const ref = { battleId: "manual-fight", bossId: 7 };
  const h = harness({ launchBattle: () => ref });
  await h.connect();
  assert.deepEqual(h.calls[0], ["GET", "/api/automation/state"]);
  assert.deepEqual(h.calls[1], [
    "POST",
    "/api/automation/launch",
    { activeBossBattle: ref },
  ]);
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls[2], ["GET", "/api/automation/state"]);
  h.disconnect();
  await h.connect();
  assert.equal(h.calls.at(-1)[1], "/api/automation/launch");
  h.disconnect();
});

test("a failed launch retries its read-only reconciliation rather than losing the reference", async () => {
  let attempts = 0;
  const h = harness({
    launchBattle: () => ({ battleId: "manual-fight", bossId: 7 }),
    request: async (method, path) => {
      if (path.endsWith("/launch") && ++attempts === 1)
        throw new Error("offline");
      return initialState();
    },
  });
  await h.connect();
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    h.calls.map((call) => call[1]),
    [
      "/api/automation/state",
      "/api/automation/launch",
      "/api/automation/launch",
    ],
  );
  assert.equal(h.bossBattle.getSnapshot().battle.id, "b-1");
  h.disconnect();
});

test("a busy launch preserves server state and retries without showing an error", async () => {
  let attempts = 0;
  const h = harness({
    launchBattle: () => ({ battleId: "manual-fight", bossId: 7 }),
    request: async (method, path) => {
      if (path.endsWith("/launch") && ++attempts === 1) {
        const error = new Error("busy");
        error.status = 409;
        error.snapshot = initialState();
        throw error;
      }
      return initialState();
    },
  });
  await h.connect();
  assert.equal(h.bossBattle.getSnapshot().error, null);
  assert.equal(h.bossBattle.getSnapshot().battle.id, "b-1");
  assert.equal([...h.tasks.values()][0].delay, 5000);
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(h.bossBattle.getSnapshot().error, null);
  assert.equal([...h.tasks.values()][0].delay, 180000);
  h.disconnect();
});

test("open merges local visibility and boss metadata; close and reset do not send server mutations", async () => {
  const h = harness();
  await h.connect();
  const calls = h.calls.length;
  await h.bossBattle.open(
    { id: 8, numericId: 8, name: "Local boss" },
    { refresh: false },
  );
  assert.equal(h.bossBattle.getSnapshot().visible, true);
  assert.equal(h.bossBattle.getSnapshot().boss.name, "Boss");
  assert.equal(h.calls.length, calls);
  h.bossBattle.close();
  assert.equal(h.bossBattle.getSnapshot().visible, false);
  h.reset();
  assert.equal(h.calls.length, calls);
  assert.equal(h.tasks.size, 0);
  assert.equal(h.bossBattle.getSnapshot().battle, null);
});

test("open commands target the numeric API id", async () => {
  const h = harness();
  await h.connect();
  await h.bossBattle.open({ id: "wiki-id", apiId: 29, name: "Boss" });
  assert.deepEqual(h.calls.at(-1), [
    "POST",
    "/api/automation/commands",
    {
      id: "id-1",
      expectedVersion: 7,
      command: "open",
      args: { bossId: 29 },
    },
  ]);
});

test("server boss remains authoritative and numeric server ids are accepted for open", async () => {
  const h = harness();
  await h.connect();
  await h.bossBattle.open(
    { id: 8, name: "Local display boss" },
    { refresh: false },
  );
  assert.deepEqual(h.bossBattle.getSnapshot().boss, { id: 8, name: "Boss" });
  await h.bossBattle.open({ id: 29, name: "API boss" });
  assert.deepEqual(h.calls.at(-1)[2].args, { bossId: 29 });
});

test("battle, medicine, purchase, auto, goal, and pvp actions map to command envelopes", async () => {
  const h = harness();
  await h.connect();
  const actions = [
    [h.bossBattle.start, "start", {}],
    [h.bossBattle.startNextBattle, "next", {}],
    [h.bossBattle.attack, "attack", {}],
    [h.bossBattle.refresh, "refresh", {}],
    [h.bossBattle.hydrateDetails, "hydrate", {}],
    [h.bossBattle.openMedicines, "medicines.open", {}],
    [h.bossBattle.closeMedicines, "medicines.close", {}],
    [
      () => h.bossBattle.useMedicine("health"),
      "medicine.use",
      { type: "health" },
    ],
    [
      () => h.bossBattle.preparePurchase("health", "gold", 2),
      "purchase.prepare",
      { type: "health", currency: "gold", quantity: 2 },
    ],
    [h.bossBattle.cancelPurchase, "purchase.cancel", {}],
    [h.bossBattle.buyMedicine, "purchase.buy", {}],
    [h.bossBattle.acknowledgePurchase, "purchase.ack", {}],
    [h.bossBattleAuto.start, "auto.start", {}],
    [h.bossBattleAuto.stop, "auto.stop", {}],
    [
      () =>
        h.bossBattleGoal.configure({
          bossId: 8,
          kind: "battles",
          targetCount: 2,
        }),
      "goal.configure",
      { bossId: 8, kind: "battles", targetCount: 2 },
    ],
    [h.bossBattleGoal.stop, "goal.stop", {}],
    [h.bossBattleGoal.reset, "goal.reset", {}],
    [
      () => h.preferences.setFavoriteBossIds([8, 29]),
      "favorites.set",
      { bossIds: [8, 29] },
    ],
    [
      () => h.businessAssistant.startRun({ businessId: "business:1" }),
      "business.run.start",
      { businessId: "business:1" },
    ],
    [h.businessAssistant.stopRun, "business.run.stop", {}],
    [() => h.workFarm.refresh(7), "work.refresh", { workId: 7 }],
    [
      () => h.workFarm.plan({ workId: 7, targetCycles: 25 }),
      "work.plan",
      { workId: 7, targetCycles: 25 },
    ],
    [
      () => h.workFarm.start({ workId: 7, targetCycles: 25 }),
      "work.start",
      { workId: 7, targetCycles: 25 },
    ],
    [h.workFarm.stop, "work.stop", {}],
    [h.pvpBattle.refresh, "pvp.refresh", {}],
  ];
  for (const [action, expectedCommand, expectedArgs] of actions) {
    await action();
    assert.equal(h.calls.at(-1)[2].command, expectedCommand);
    assert.deepEqual(h.calls.at(-1)[2].args, expectedArgs);
  }
});

test("one mutation at a time; failed commands resolve and are never retried", async () => {
  let finish;
  const h = harness({
    request: (...args) => {
      if (args[0] === "GET") return initialState();
      return new Promise((resolve, reject) => {
        finish = { resolve, reject };
      });
    },
  });
  await h.connect();
  const first = h.bossBattle.attack();
  assert.equal(await h.bossBattle.refresh(), false);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 1);
  finish.reject(Object.assign(new Error("offline"), { status: 503 }));
  assert.equal(await first, false);
  assert.equal(h.bossBattle.getSnapshot().needsRefresh, true);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 1);
});

test("urgent stop commands can overlap a pending action without unlocking ordinary commands", async () => {
  const deferred = [];
  const h = harness({
    request: (method) => {
      if (method === "GET") return initialState();
      return new Promise((resolve) => deferred.push(resolve));
    },
  });
  await h.connect();
  const attack = h.bossBattle.attack();
  const stopped = h.bossBattleAuto.stop();
  assert.equal(await h.bossBattle.refresh(), false);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 2);
  deferred[0]({ ...initialState(), version: 9 });
  assert.equal(await attack, true);
  assert.equal(await h.bossBattle.refresh(), false);
  deferred[1]({
    ...initialState(),
    version: 10,
    auto: { enabled: false, nextAttackAt: null, pause: false },
  });
  assert.equal(await stopped, true);
});

test("business run stop is urgent while a run start command is pending", async () => {
  const deferred = [];
  const h = harness({
    request: (method) => {
      if (method === "GET") return initialState();
      return new Promise((resolve) => deferred.push(resolve));
    },
  });
  await h.connect();
  const start = h.businessAssistant.startRun({ businessId: "business:1" });
  const stop = h.businessAssistant.stopRun();
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 2);
  deferred[0]({ ...initialState(), version: 9 });
  assert.equal(await start, true);
  deferred[1]({ ...initialState(), version: 10 });
  assert.equal(await stop, true);
});

test("an older in-flight poll response cannot overwrite a newer command snapshot", async () => {
  let finishPoll;
  let pollStarted = false;
  const h = harness({
    request: (method) => {
      if (method === "GET") {
        if (!pollStarted) {
          pollStarted = true;
          return initialState();
        }
        return new Promise((resolve) => {
          finishPoll = resolve;
        });
      }
      return {
        ...initialState(),
        version: 9,
        battle: { battle: { id: "command-new" } },
      };
    },
  });
  await h.connect();
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  const command = h.bossBattle.attack();
  await command;
  finishPoll({
    ...initialState(),
    version: 8,
    battle: { battle: { id: "poll-old" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.bossBattle.getSnapshot().battle.id, "command-new");
});

test("409 snapshot is adopted, and polling errors retain the last known server state", async () => {
  let failGets = false;
  const conflictState = {
    ...initialState(),
    version: 10,
    battle: { battle: { id: "new" } },
  };
  const h = harness({
    request: async (method) => {
      if (method === "GET") {
        if (failGets)
          throw Object.assign(new Error("offline"), { status: 503 });
        return initialState();
      }
      throw Object.assign(new Error("conflict"), {
        status: 409,
        snapshot: conflictState,
      });
    },
  });
  await h.connect();
  await h.bossBattle.attack();
  assert.equal(h.bossBattle.getSnapshot().battle.id, "new");
  failGets = true;
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.bossBattle.getSnapshot().battle.id, "new");
  assert.equal(h.bossBattle.getSnapshot().needsRefresh, true);
  assert.equal(h.bossBattle.getSnapshot().errorStatus, 503);
  assert.equal([...h.tasks.values()][0].delay, 5000);
});

test("subscription conflict shows feedback without replaying the command", async () => {
  const conflictState = { ...initialState(), version: 10 };
  const h = harness({
    request: async (method) => {
      if (method === "GET") return initialState();
      throw Object.assign(new Error("conflict"), {
        status: 409,
        snapshot: conflictState,
      });
    },
  });
  await h.connect();
  assert.equal(await h.raidSubscriptions.start(42, 8, "leader"), false);
  assert.match(h.raidSubscriptions.getSnapshot().error, /Состояние изменилось/);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 1);
  h.disconnect();
});

test("business start conflict shows feedback without replaying the command", async () => {
  const h = harness({
    request: async (method) => {
      if (method === "GET") return initialState();
      throw Object.assign(new Error("conflict"), {
        status: 409,
        snapshot: { ...initialState(), version: 10 },
      });
    },
  });
  await h.connect();
  assert.equal(
    await h.businessAssistant.startRun({ businessId: "business:58" }),
    false,
  );
  assert.match(h.businessAssistant.getSnapshot().error, /Состояние изменилось/);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 1);
  h.disconnect();
});

test("work.refresh rebases once on a 409 snapshot, while mutations are never retried", async () => {
  const rebased = {
    ...initialState(),
    version: 8,
    workFarm: { view: { workId: 7 } },
  };
  const calls = [];
  const h = harness({
    request: async (method, _path, body) => {
      if (method === "GET") return initialState();
      calls.push(body);
      if (calls.length === 1)
        throw Object.assign(
          new Error("state changed; refresh and retry manually"),
          {
            status: 409,
            snapshot: rebased,
          },
        );
      return {
        ...rebased,
        version: 9,
        workFarm: { view: { workId: 7, energy: 3 } },
      };
    },
  });
  await h.connect();
  assert.equal(await h.workFarm.refresh(7), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].expectedVersion, 8);
  assert.equal(h.workFarm.getSnapshot().error, null);
  assert.equal(h.workFarm.getSnapshot().view.energy, 3);
  h.disconnect();

  const mutationCalls = [];
  const mutation = harness({
    request: async (method, _path, body) => {
      if (method === "GET") return initialState();
      mutationCalls.push(body);
      throw Object.assign(new Error("conflict"), {
        status: 409,
        snapshot: rebased,
      });
    },
  });
  await mutation.connect();
  assert.equal(await mutation.workFarm.start({ workId: 7 }), false);
  assert.equal(mutationCalls.length, 1);
  mutation.disconnect();
});

test("disconnect invalidates stale replies, cancels polling, and does not stop persisted server state", async () => {
  let finish;
  let serverRecord = initialState();
  const h = harness({
    request: (method, _path) => {
      if (method === "GET") return Promise.resolve(serverRecord);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await h.connect();
  const pending = h.bossBattleAuto.start();
  h.disconnect();
  serverRecord = {
    ...serverRecord,
    auto: { enabled: true, nextAttackAt: 123, pause: false },
  };
  finish(serverRecord);
  assert.equal(await pending, false);
  assert.equal(h.bossBattleAuto.getSnapshot().enabled, false);
  assert.equal(h.calls.filter(([method]) => method === "POST").length, 1);
  assert.equal(h.tasks.size, 0);
  await h.connect();
  assert.equal(h.bossBattleAuto.getSnapshot().enabled, true);
});

test("pvp visibility is local and refresh is a server command", async () => {
  const h = harness();
  await h.connect();
  const before = h.calls.length;
  await h.pvpBattle.open();
  assert.equal(h.pvpBattle.getSnapshot().visible, true);
  assert.equal(h.bossBattle.getSnapshot().visible, false);
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1)[2].command, "pvp.refresh");
  h.pvpBattle.close();
  assert.equal(h.pvpBattle.getSnapshot().visible, false);
});

test("business helper observes server plans and uses only shared command endpoints", async () => {
  const h = harness({
    state: {
      ...initialState(),
      businessAssistant: {
        plans: [{ businessId: "business:7", targetLevel: 3 }],
        notice: null,
      },
    },
  });
  await h.connect();
  assert.equal(h.businessAssistant.getSnapshot().loaded, true);
  assert.equal(h.businessAssistant.getSnapshot().plans[0].targetLevel, 3);
  await h.businessAssistant.select("business:7");
  await h.businessAssistant.save({
    businessId: "business:7",
    targetLevel: 4,
    currentLevelOverride: null,
    maxAttempts: null,
  });
  await h.businessAssistant.refresh("business:7");
  await h.businessAssistant.createGoal({
    businessId: "business:7",
    itemId: 55,
    bossId: 17,
    expectedMissing: 5,
  });
  assert.deepEqual(
    h.requests
      .filter(([method]) => method === "POST")
      .map(([, path, body]) => [path, body.command]),
    [
      ["/api/automation/commands", "business.select"],
      ["/api/automation/commands", "business.save"],
      ["/api/automation/commands", "business.refresh"],
      ["/api/automation/commands", "business.goal"],
    ],
  );
  h.disconnect();
  assert.deepEqual(h.businessAssistant.getSnapshot().plans, []);
});

test("work stop overlaps a pending work action and clears account snapshots on disconnect", async () => {
  let finish;
  const state = {
    ...initialState(),
    workFarm: { view: { workId: 7 }, run: { status: "running", workId: 7 } },
  };
  const h = harness({
    request: (method, path, body) => {
      if (method === "GET") return state;
      if (body.command === "work.stop")
        return {
          ...state,
          version: 9,
          workFarm: { ...state.workFarm, run: { status: "stopped" } },
        };
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  await h.connect();
  const start = h.workFarm.start({ workId: 7 });
  assert.equal(h.workFarm.getSnapshot().pending, true);
  assert.equal(await h.workFarm.stop(), true);
  assert.equal(h.workFarm.getSnapshot().run.status, "stopped");
  finish({ ...state, version: 8 });
  await start;
  assert.equal(h.workFarm.getSnapshot().run.status, "stopped");
  h.disconnect();
  assert.equal(h.workFarm.getSnapshot().view, null);
  assert.equal(h.workFarm.getSnapshot().run, null);
});

test("boss opening requirements stay in dialog context without becoming a game goal", async () => {
  let state = initialState();
  const h = harness({
    request: (method, path, body) => {
      if (method === "GET") return state;
      state = {
        ...state,
        version: state.version + 1,
        battle: { boss: { id: body.args.bossId, name: "Boss" }, battle: null },
      };
      return state;
    },
  });
  await h.connect();
  const requirements = [
    {
      category: "bosses",
      entityId: "boss:8",
      destination: "K1",
      label: "Победить босса 5 раз",
      note: "Условие неполное",
      verification: "Нужна проверка",
    },
  ];
  await h.bossBattle.open(
    { numericId: 8 },
    { openingRequirements: requirements },
  );
  assert.deepEqual(h.bossBattle.getSnapshot().openingRequirements, [
    {
      destination: "K1",
      label: requirements[0].label,
      note: requirements[0].note,
      verification: requirements[0].verification,
      category: "bosses",
    },
  ]);
  assert.deepEqual(h.calls.at(-1)[2].args, { bossId: 8 });
  assert.equal(h.bossBattleGoal.getSnapshot(), null);
  h.bossBattle.close();
  const count = h.calls.length;
  await h.bossBattle.open({ numericId: 8 }, { refresh: false });
  assert.equal(h.calls.length, count);
  assert.equal(
    h.bossBattle.getSnapshot().openingRequirements[0].destination,
    "K1",
  );
  await h.bossBattle.open({ numericId: 29 });
  assert.deepEqual(h.bossBattle.getSnapshot().openingRequirements, []);
  await h.bossBattle.open(
    { numericId: 29 },
    { openingRequirements: requirements },
  );
  await h.bossBattle.open(
    { numericId: 29 },
    { openingRequirements: [], refresh: false },
  );
  assert.deepEqual(h.bossBattle.getSnapshot().openingRequirements, []);
  h.disconnect();
  assert.deepEqual(h.bossBattle.getSnapshot().openingRequirements, []);
});

test("idle state polls slowly while active server automation keeps short updates", async () => {
  const idle = harness({
    state: { ...initialState(), battle: { battle: null } },
  });
  await idle.connect();
  assert.equal([...idle.tasks.values()][0].delay, 180000);
  const active = harness({
    state: { ...initialState(), auto: { enabled: true } },
  });
  await active.connect();
  assert.equal([...active.tasks.values()][0].delay, 2000);
  idle.disconnect();
  active.disconnect();
});

test("hidden clients stop state polling and resume once when visible", async () => {
  let onChange;
  const visibility = {
    visibilityState: "visible",
    addEventListener(type, callback) {
      onChange = callback;
    },
    removeEventListener() {
      onChange = null;
    },
  };
  const tasks = new Map();
  let id = 0;
  let calls = 0;
  const remote = createRemoteBattleSession({
    request: async () => {
      calls++;
      return initialState();
    },
    schedule: (fn, delay) => {
      tasks.set(++id, { fn, delay });
      return id;
    },
    cancel: (key) => tasks.delete(key),
    visibility,
  });
  await remote.connect();
  visibility.visibilityState = "hidden";
  onChange();
  assert.equal(tasks.size, 0);
  visibility.visibilityState = "visible";
  onChange();
  assert.equal(tasks.size, 1);
  assert.equal([...tasks.values()][0].delay, 0);
  assert.equal(calls, 1);
  remote.disconnect();
  assert.equal(tasks.size, 0);
  assert.equal(onChange, null);
});

test("a failed boss command does not mark work or businesses unavailable", async () => {
  const h = harness({
    request: async (method) => {
      if (method === "GET") return initialState();
      throw new Error("Boss action failed");
    },
  });
  await h.connect();
  await h.workFarm.refresh(7);
  assert.equal(h.workFarm.getSnapshot().error, "Boss action failed");
  assert.equal(h.businessAssistant.getSnapshot().error, null);
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.workFarm.getSnapshot().error, null);
  await h.bossBattle.refresh();
  assert.equal(h.workFarm.getSnapshot().error, null);
  assert.equal(h.businessAssistant.getSnapshot().error, null);
  h.disconnect();
});

test("idle state connection errors retry promptly and clear after recovery", async () => {
  let fail = true;
  const h = harness({
    request: async () => {
      if (fail) throw new Error("Offline");
      return initialState();
    },
  });
  await h.connect();
  assert.equal(h.workFarm.getSnapshot().error, "Offline");
  assert.equal([...h.tasks.values()][0].delay, 5000);
  fail = false;
  h.runTimer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.workFarm.getSnapshot().error, null);
  assert.equal([...h.tasks.values()][0].delay, 180000);
  h.disconnect();
});

test("selecting a new boss hides the previous result until server reconciliation finishes", async () => {
  let release;
  const old = initialState();
  old.battle.battle.status = "won";
  const h = harness({
    request: async (method) =>
      method === "GET"
        ? old
        : new Promise((resolve) => {
            release = resolve;
          }),
  });
  await h.connect();
  const opening = h.bossBattle.open({ numericId: 29, name: "Selected" });
  assert.equal(h.bossBattle.getSnapshot().boss.name, "Selected");
  assert.equal(h.bossBattle.getSnapshot().battle, null);
  assert.equal(h.bossBattle.getSnapshot().pending, "command");
  release({
    ...old,
    version: 8,
    battle: {
      boss: { id: 29, name: "Selected" },
      battle: null,
      canStart: true,
    },
  });
  await opening;
  assert.equal(h.bossBattle.getSnapshot().boss.id, 29);
  assert.equal(h.bossBattle.getSnapshot().pending, null);
  h.disconnect();
});

test("invitations are server-backed and accepting opens only the confirmed joined fight", async () => {
  const state = {
    ...initialState(),
    battle: {},
    invitations: {
      items: [{ invitationId: "invite-1", bossId: 8 }],
      loaded: true,
    },
  };
  const h = harness({
    request: async (method, path, body) => {
      if (method === "GET" || body.command === "invitations.refresh")
        return state;
      assert.equal(body.command, "invitations.accept");
      assert.deepEqual(body.args, { invitationId: "invite-1" });
      return {
        ...state,
        version: 8,
        battle: {
          boss: { id: 8, name: "Joined" },
          battle: { id: "raid-1", status: "active" },
          invitationOnly: true,
        },
      };
    },
  });
  await h.connect();
  assert.equal(h.bossInvitations.getSnapshot().items.length, 1);
  await h.bossInvitations.refresh();
  assert.equal(h.bossBattle.getSnapshot().visible, false);
  assert.equal(await h.bossInvitations.accept("invite-1"), true);
  assert.equal(h.bossBattle.getSnapshot().visible, true);
  assert.equal(h.bossBattle.getSnapshot().battle.id, "raid-1");
  assert.equal(h.bossBattle.getSnapshot().invitationOnly, true);
  h.disconnect();
  assert.equal(h.bossInvitations.getSnapshot().items.length, 0);
});

test("uncertain invitation acceptance never opens the prior battle or retries the command", async () => {
  let posts = 0;
  const h = harness({
    request: async (method) => {
      if (method === "GET") return initialState();
      posts++;
      const error = new Error("check participation");
      error.status = 409;
      error.snapshot = {
        ...initialState(),
        version: 8,
        invitations: { items: [], notice: "Проверить вступление" },
        battle: {
          boss: { id: 8 },
          battle: null,
          pendingInvitation: { invitationId: "i" },
        },
      };
      throw error;
    },
  });
  await h.connect();
  assert.equal(await h.bossInvitations.accept("i"), false);
  assert.equal(h.bossInvitations.getSnapshot().unresolved, true);
  assert.equal(h.bossBattle.getSnapshot().visible, false);
  assert.equal(posts, 1);
});

test("raid intent comes from server state and start/stop send commands without local execution", async () => {
  const state = {
    ...initialState(),
    raid: { enabled: true, status: "waiting", bossId: 8 },
  };
  const h = harness({ state });
  await h.connect();
  assert.deepEqual(h.bossBattle.getSnapshot().raid, state.raid);
  assert.equal([...h.tasks.values()][0].delay, 2000);
  const settings = { bossId: 8, kind: "battles", targetCount: 3 };
  await h.bossBattleAuto.startRaid(settings);
  assert.equal(h.calls.at(-1)[2].command, "raid.start");
  assert.deepEqual(h.calls.at(-1)[2].args, { settings });
  await h.bossBattleAuto.stopRaid();
  assert.equal(h.calls.at(-1)[2].command, "raid.stop");
  h.disconnect();
  assert.equal(h.tasks.size, 0);
});

test("a failed live launch still exposes the saved work goal and its stop command", async () => {
  const state = {
    ...initialState(),
    workFarm: { run: { status: "running", workId: 28, phase: "retrying" } },
  };
  const h = harness({
    launchBattle: () => null,
    request: async (method, path) => {
      if (path.endsWith("/launch"))
        throw Object.assign(new Error("game offline"), { status: 503 });
      return state;
    },
  });
  await h.connect();
  assert.equal(h.workFarm.getSnapshot().run.status, "running");
  assert.equal(await h.workFarm.stop(), true);
  assert.equal(h.calls.at(-1)[2].command, "work.stop");
  h.disconnect();
});
