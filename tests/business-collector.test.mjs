import test from "node:test";
import assert from "node:assert/strict";
import { createBusinessCollector } from "../scripts/automation/business-collector.mjs";

const businessId = "business:1";
const expectedPlan = {
  targetLevel: 2,
  currentLevelOverride: 1,
  maxAttempts: 4,
  durationHours: 2,
  bossChoices: { 51: 901, 52: 902 },
};

function harness({
  inventory = { 51: 0, 52: 0 },
  config = expectedPlan,
  now = 1000,
  getImpl,
  run,
  goalStatus = null,
  failOpenOnce = false,
  priorityActive = () => false,
  upgrade,
} = {}) {
  const helper = {
    configs: { [businessId]: structuredClone(config) },
    resources: {
      details: { [businessId]: { level: 1 } },
      inventory: { stock: { ...inventory }, complete: true },
      updatedAt: null,
    },
    run: run ? structuredClone(run) : null,
  };
  const catalogue = {
    businesses: [
      { id: businessId, apiId: "1", title: "Workshop", maxLevel: 2 },
    ],
    businessUpgrades: [
      {
        businessId,
        items: [
          { entityId: 51, name: "Bolt", levels: [0, 2] },
          { entityId: 52, name: "Key", levels: [0, 1] },
        ],
      },
    ],
    bosses: [
      {
        id: "boss:901",
        numericId: 901,
        name: "Assembler",
        dropItems: [{ entityId: 51 }],
      },
      {
        id: "boss:902",
        numericId: 902,
        name: "Watcher",
        possibleDrops: [{ type: "activity_item", entityId: 52 }],
      },
    ],
  };
  const listeners = () => new Set();
  const controllerListeners = listeners();
  const goalListeners = listeners();
  const autoListeners = listeners();
  const state = {
    boss: null,
    battle: null,
    pending: null,
    needsRefresh: false,
    error: null,
    purchaseUncertain: false,
    canStart: true,
  };
  const controller = {
    opens: [],
    refreshes: [],
    getSnapshot: () => state,
    subscribe(fn) {
      controllerListeners.add(fn);
      return () => controllerListeners.delete(fn);
    },
    emit() {
      for (const fn of [...controllerListeners]) fn();
    },
    async refresh(options) {
      this.refreshes.push(options);
      Object.assign(state, { needsRefresh: false, error: null });
      this.emit();
    },
    async open(boss) {
      this.opens.push(boss);
      if (failOpenOnce) {
        failOpenOnce = false;
        state.needsRefresh = true;
        this.emit();
        throw new TypeError("temporary open failure");
      }
      Object.assign(state, {
        boss,
        battle: null,
        pending: null,
        needsRefresh: false,
        error: null,
      });
      this.emit();
    },
  };
  let currentGoal = goalStatus
    ? { status: goalStatus, rewardUncertain: false }
    : null;
  const goal = {
    configurations: [],
    stops: 0,
    getSnapshot: () => currentGoal,
    subscribe(fn) {
      goalListeners.add(fn);
      return () => goalListeners.delete(fn);
    },
    configure(value) {
      this.configurations.push(value);
      currentGoal = { status: "active", rewardUncertain: false };
      this.emit();
    },
    stop() {
      this.stops++;
      currentGoal = { ...(currentGoal ?? {}), status: "stopped" };
      this.emit();
    },
    emit() {
      for (const fn of [...goalListeners]) fn();
    },
  };
  const autoState = { enabled: false };
  const auto = {
    starts: [],
    stops: 0,
    getSnapshot: () => autoState,
    subscribe(fn) {
      autoListeners.add(fn);
      return () => autoListeners.delete(fn);
    },
    start(checkpoint) {
      this.starts.push(checkpoint);
      autoState.enabled = true;
      this.emit();
      return true;
    },
    stop() {
      this.stops++;
      autoState.enabled = false;
      this.emit();
    },
    emit() {
      for (const fn of [...autoListeners]) fn();
    },
  };
  const timers = [];
  const gets = [];
  const get = async (path) => {
    gets.push(path);
    return getImpl
      ? getImpl(path)
      : path === "/api/me/bag"
        ? {
            activityItems: Object.entries(helper.resources.inventory.stock).map(
              ([itemId, quantity]) => ({ itemId: Number(itemId), quantity }),
            ),
          }
        : { id: 1, level: 1 };
  };
  const bossRecords = new Map(
    catalogue.bosses.map((record) => [
      record.numericId,
      {
        id: record.numericId,
        name: record.name,
        reference: {
          possibleDrops:
            record.possibleDrops ??
            record.dropItems.map((item) => ({
              ...item,
              type: "activity_item",
            })),
        },
      },
    ]),
  );
  const collector = createBusinessCollector({
    helper,
    controller,
    goal,
    auto,
    getCatalogue: () => catalogue,
    getBoss: async (id) => bossRecords.get(id),
    get,
    upgrade,
    priorityActive,
    now: () => now,
    schedule(fn, delay) {
      const timer = { fn, delay, canceled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.canceled = true;
    },
  });
  const next = async () => {
    const timer = timers.find((item) => !item.canceled);
    if (!timer) return false;
    timer.canceled = true;
    timer.fn();
    await new Promise((resolve) => setImmediate(resolve));
    return true;
  };
  const drain = async () => {
    for (let index = 0; index < 12; index++) {
      if (!(await next())) break;
    }
  };
  const start = () =>
    collector.start({
      businessId,
      expectedPlan: structuredClone(config),
      expectedMissing: [
        ...(inventory[51] < 2
          ? [{ itemId: 51, amount: 2 - inventory[51] }]
          : []),
        ...(inventory[52] < 1
          ? [{ itemId: 52, amount: 1 - inventory[52] }]
          : []),
      ],
    });
  return {
    helper,
    catalogue,
    controller,
    goal,
    auto,
    state,
    timers,
    gets,
    collector,
    next,
    drain,
    start,
    setNow(value) {
      now = value;
    },
  };
}

test("farms materials sequentially and switches to the next material boss after verification", async () => {
  const h = harness();
  h.start();
  await h.drain();
  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [901],
  );
  assert.equal(h.goal.configurations[0].items[0].key, "activity_item:51");
  assert.equal(h.helper.run.phase, "farming");

  h.helper.resources.inventory.stock[51] = 2;
  h.state.battle = { id: "battle-a", status: "won" };
  h.controller.emit();
  Object.assign(h.goal.getSnapshot(), { status: "completed" });
  h.goal.emit();
  await h.drain();

  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [901, 902],
  );
  assert.deepEqual(
    h.goal.configurations.map((item) => item.items[0].key),
    ["activity_item:51", "activity_item:52"],
  );
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.currentItemId, 52);
});

test("verification skips material collected incidentally before its stage", async () => {
  const h = harness({ inventory: { 51: 2, 52: 0 } });
  h.start();
  await h.drain();
  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [902],
  );
  assert.deepEqual(
    h.goal.configurations.map((item) => item.items[0].key),
    ["activity_item:52"],
  );
});

test("global battle cap applies across material stages", async () => {
  const config = { ...expectedPlan, maxAttempts: 1 };
  const h = harness({ config });
  h.start();
  await h.drain();
  h.state.battle = { id: "battle-cap", status: "won" };
  h.controller.emit();
  Object.assign(h.goal.getSnapshot(), { status: "completed" });
  h.goal.emit();
  await h.drain();
  assert.equal(h.helper.run.status, "limited");
  assert.equal(h.helper.run.battlesStarted, 1);
  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [901],
  );
});

test("deadline stops the collector without opening another boss", async () => {
  const h = harness();
  h.start();
  await h.drain();
  h.setNow(h.helper.run.deadlineAt);
  h.collector.tick();
  assert.equal(h.helper.run.status, "limited");
  assert.equal(h.helper.run.reason, "Истекло время сбора.");
  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [901],
  );
});

test("temporary read outage keeps the run and resumes from fresh reads", async () => {
  let offline = true;
  const h = harness({
    getImpl: (path) => {
      if (offline) throw new TypeError("offline");
      return path === "/api/me/bag"
        ? { activityItems: [] }
        : { id: 1, level: 1 };
    },
  });
  h.start();
  await h.next();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "retrying");
  assert.equal(h.helper.run.nextRetryAt, 31000);
  assert.equal(h.controller.opens.length, 0);

  offline = false;
  h.setNow(h.helper.run.nextRetryAt);
  await h.drain();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "farming");
  assert.equal(h.helper.run.nextRetryAt, null);
  assert.deepEqual(
    h.controller.opens.map((boss) => boss.id),
    [901],
  );
  assert.ok(
    h.gets.length >= 4,
    "recovery performs new inventory and detail reads",
  );
});

test("stopping during a retry wait cancels the scheduled recovery", async () => {
  const h = harness({
    getImpl: () => {
      throw new TypeError("offline");
    },
  });
  h.start();
  await h.next();
  const retryTimer = h.timers.find((item) => !item.canceled);
  assert.ok(retryTimer);
  assert.ok(retryTimer.delay > 0);
  h.collector.stop();
  assert.equal(retryTimer.canceled, true);
  assert.equal(h.helper.run.status, "stopped");
  assert.equal(await h.next(), false);
  assert.equal(h.gets.length, 2);
});

test("failed boss opening recovers controller state before retrying", async () => {
  const h = harness({ failOpenOnce: true });
  h.start();
  await h.next();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "retrying");
  assert.equal(
    h.helper.run.reason,
    "Игровые данные временно недоступны. Цель сохранена; повторим проверку.",
  );

  h.setNow(h.helper.run.nextRetryAt);
  await h.drain();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "farming");
  assert.equal(h.helper.run.reason, null);
  assert.deepEqual(h.controller.refreshes, [{ discover: true }]);
  assert.equal(h.goal.configurations.length, 1);
});

test("urgent stop during held inventory refresh invalidates the step", async () => {
  let release;
  const h = harness({
    getImpl: (path) =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            path === "/api/me/bag"
              ? { activityItems: [] }
              : { id: 1, level: 1 },
          );
      }),
  });
  h.start();
  const work = h.next();
  assert.equal(h.helper.run.phase, "verifying");
  h.collector.stop();
  assert.equal(h.helper.run.status, "stopped");
  release();
  await work;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.controller.opens.length, 0);
  assert.equal(h.goal.configurations.length, 0);
});

test("safe restart resumes an active farming goal without reopening or refreshing", async () => {
  const run = {
    id: "run-1",
    status: "running",
    phase: "farming",
    businessId,
    config: structuredClone(expectedPlan),
    deadlineAt: 7200001,
    maxBattles: 4,
    battlesStarted: 1,
    battlesCompleted: 0,
    attemptIds: ["battle-restored"],
    completedIds: [],
    materials: [],
    bossId: 901,
    currentItemId: 51,
    ownsGoal: true,
  };
  const h = harness({ run, goalStatus: "active" });
  h.collector.resume({ nextAttackAt: 2000 });
  assert.equal(h.auto.starts.length, 1);
  assert.deepEqual(h.auto.starts[0], { checkpoint: { nextAttackAt: 2000 } });
  assert.equal(h.controller.opens.length, 0);
  assert.equal(h.gets.length, 0);
  assert.equal(h.helper.run.status, "running");
});

test("unsafe restart checkpoint preserves intent for read reconciliation without replaying a battle", () => {
  const run = {
    id: "run-unsafe",
    status: "running",
    phase: "farming",
    businessId,
    ownsGoal: true,
  };
  const h = harness({ run });
  h.collector.resume(null, true);
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "retrying");
  assert.ok(h.helper.run.nextRetryAt > 0);
  assert.equal(h.auto.starts.length, 0);
  assert.equal(h.controller.opens.length, 0);
});

test("suspending between battles keeps the business run and goal intact until resumed", async () => {
  const h = harness();
  h.start();
  await h.drain();
  const before = structuredClone(h.helper.run);
  const goalBefore = structuredClone(h.goal.getSnapshot());
  assert.equal(h.collector.suspend(), true);
  assert.deepEqual(h.helper.run, before);
  assert.deepEqual(h.goal.getSnapshot(), goalBefore);
  assert.equal(h.auto.getSnapshot().enabled, false);
  h.controller.emit();
  await h.drain();
  assert.equal(h.controller.opens.length, 1);
  h.collector.resume({ nextAttackAt: 2000 });
  assert.equal(h.auto.getSnapshot().enabled, true);
  assert.deepEqual(h.auto.starts.at(-1), {
    checkpoint: { nextAttackAt: 2000 },
  });
});

test("suspension waits for the current battle or unresolved action", async () => {
  const h = harness();
  h.start();
  await h.drain();
  h.state.battle = { id: "battle-active", status: "active" };
  assert.equal(h.collector.suspend(), false);
  assert.equal(h.auto.getSnapshot().enabled, true);
  h.state.battle = { id: "battle-ended", status: "won" };
  h.state.pending = "attack";
  assert.equal(h.collector.suspend(), false);
  assert.equal(h.helper.run.status, "running");
});

test("business collection waits for character priority and resumes its saved plan", async () => {
  let priority = true;
  const h = harness({ priorityActive: () => priority });
  h.start();
  const stopsBefore = h.auto.stops;
  await h.next();
  assert.equal(h.helper.run.status, "running");
  assert.deepEqual(h.gets, []);
  assert.equal(h.auto.stops, stopsBefore);
  assert.ok(h.timers.some((timer) => !timer.canceled && timer.delay === 1000));
  priority = false;
  await h.drain();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.helper.run.phase, "farming");
  assert.equal(h.controller.opens.length, 1);
});

test("business pause preserves its goal and resumes the same run after restart", async () => {
  const h = harness();
  h.start();
  await h.drain();
  const id = h.helper.run.id;
  assert.equal(h.auto.getSnapshot().enabled, true);
  assert.equal(h.collector.pause(), true);
  assert.equal(h.helper.run.status, "paused");
  assert.equal(h.goal.getSnapshot().status, "active");
  assert.equal(h.auto.getSnapshot().enabled, false);
  assert.throws(() => h.start(), /business_run_active/);
  const restored = harness({ run: h.helper.run, goalStatus: "active" });
  restored.collector.tick();
  assert.equal(restored.auto.starts.length, 0);
  assert.equal(restored.collector.resumePaused(), true);
  restored.collector.tick();
  assert.equal(restored.helper.run.id, id);
  assert.equal(restored.helper.run.status, "running");
  assert.equal(restored.auto.starts.length, 1);
});

test("business resume waits for the read that was in flight during pause", async () => {
  const releases = [];
  const h = harness({
    getImpl: (path) =>
      new Promise((resolve) => {
        releases.push(() =>
          resolve(
            path === "/api/me/bag"
              ? { activityItems: [] }
              : { id: 1, level: 1 },
          ),
        );
      }),
  });
  h.start();
  const old = h.next();
  assert.equal(h.collector.pause(), true);
  assert.equal(h.collector.resumePaused(), true);
  h.collector.tick();
  assert.equal(h.helper.run.status, "paused");
  releases.forEach((release) => release());
  await old;
  await new Promise((resolve) => setImmediate(resolve));
  h.collector.tick();
  assert.equal(h.helper.run.status, "running");
  assert.equal(h.controller.opens.length, 0);
});

test("paused business reconciles an uncertain upgrade by reads only", async () => {
  const run = {
    id: "run-pending",
    status: "paused",
    phase: "verifying",
    businessId,
    config: structuredClone(expectedPlan),
    targetLevel: 2,
    pendingUpgrade: { businessId: 1, fromLevel: 1, operationId: "upgrade-1" },
    attemptIds: [],
    completedIds: [],
  };
  let calls = 0;
  const h = harness({
    run,
    upgrade: async (current, allowed) => {
      calls++;
      assert.equal(allowed(), false);
      assert.ok(current.pendingUpgrade);
      current.pendingUpgrade = null;
      return { status: "confirmed" };
    },
  });
  h.collector.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(h.helper.run.pendingUpgrade, null);
  assert.equal(h.helper.run.status, "paused");
  assert.equal(h.auto.starts.length, 0);
});

test("stopping while paused upgrade reconciliation is in flight finishes without resuming the run", async () => {
  const run = {
    id: "run-pending",
    status: "paused",
    phase: "verifying",
    businessId,
    config: structuredClone(expectedPlan),
    targetLevel: 2,
    pendingUpgrade: { businessId: 1, fromLevel: 1, operationId: "upgrade-1" },
    attemptIds: [],
    completedIds: [],
    ownsGoal: true,
  };
  let release;
  const h = harness({
    run,
    upgrade: async (current, allowed) => {
      assert.equal(allowed(), false);
      await new Promise((resolve) => {
        release = resolve;
      });
      current.pendingUpgrade = null;
      return { status: "confirmed" };
    },
  });
  h.collector.tick();
  assert.ok(release);
  h.collector.stop();
  assert.equal(h.helper.run.stopRequested, true);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.helper.run.status, "stopped");
  assert.equal(h.auto.starts.length, 0);
  assert.equal(h.goal.stops, 1);
});
