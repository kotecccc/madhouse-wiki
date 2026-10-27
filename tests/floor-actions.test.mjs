import test from "node:test";
import assert from "node:assert/strict";
import { createFloorActions } from "../scripts/automation/floor-actions.mjs";

function fixture() {
  let battle = { boss: null, battle: null },
    goal = null,
    auto = false,
    raid = false,
    work = null,
    collector = null;
  const entry = {
    controller: {
      getSnapshot: () => battle,
      open: async (boss) => {
        battle = { boss: { id: boss.numericId }, battle: null };
      },
    },
    workFarm: {
      running: () => work?.status === "running",
      getSnapshot: () => ({ run: work }),
      start: (args) => {
        work = { ...args, status: "running" };
      },
      stop: () => {
        work.status = "stopped";
      },
    },
    collector: {
      running: () => collector?.status === "running",
      start: (args) => {
        collector = { ...args, status: "running" };
        entry.businessHelper.run = {
          businessId: args.businessId,
          targetLevel: args.expectedPlan.targetLevel,
          status: "running",
        };
      },
      stop: () => {},
    },
    auto: {
      getSnapshot: () => ({ enabled: auto }),
      start: () => {
        auto = true;
        return true;
      },
      stop: () => {
        auto = false;
      },
    },
    raidWorker: {
      getSnapshot: () => ({ enabled: raid }),
      start: () => {
        raid = true;
        return true;
      },
      stop: () => {
        raid = false;
      },
    },
    assistant: { begin: () => true },
    raidSubscription: { getSnapshot: () => ({ enabled: false }) },
    goal: {
      getSnapshot: () => goal,
      stop: () => {
        goal = { ...goal, status: "stopped" };
      },
    },
    businessHelper: {
      configs: {},
      resources: { details: {}, inventory: null },
      run: null,
    },
  };
  const catalogue = {
    businesses: [
      { id: "business:7", apiId: "7", title: "Workshop", maxLevel: 2 },
    ],
    businessUpgrades: [
      {
        businessId: "business:7",
        items: [{ entityId: 55, name: "Item", levels: [1, 1] }],
      },
    ],
    bosses: [
      {
        numericId: 17,
        possibleDrops: [{ type: "activity_item", entityId: 55, name: "Item" }],
      },
    ],
  };
  const actions = createFloorActions({
    entry,
    now: () => 1,
    getCatalogue: () => catalogue,
    getBoss: async (id) => ({ numericId: id }),
    refreshAutoDamageLimit: async () => true,
    configureAutoGoal: (_entry, settings) => {
      goal = { boss: { id: settings.bossId }, status: "active", settings };
    },
    get: async (path) =>
      path === "/api/me/bag"
        ? { activityItems: [] }
        : {
            id: 7,
            level: 1,
            maxLevel: 2,
            canUpgrade: true,
            nextUpgradePrice: 100,
            nextUpgradeCurrency: "gold",
            requiredItems: [{ itemId: 55, requiredAmount: 1, playerAmount: 0 }],
          },
  });
  return { entry, actions, goal: () => goal, collector: () => collector };
}
test("boss target starts a win-counted series and can stop only its own goal", async () => {
  const h = fixture(),
    target = { kind: "boss", apiId: 17, current: 3, required: 5 };
  await h.actions.launch(target, () => true);
  assert.equal(h.goal().settings.targetCount, 2);
  assert.equal(h.goal().settings.countWins, true);
  assert.equal(await h.actions.observe(target), "running");
  h.actions.stopOwned(target);
  assert.equal(h.goal().status, "stopped");
});
test("business target creates the existing material collection and upgrade plan", async () => {
  const h = fixture(),
    target = {
      kind: "business",
      entityId: "business:7",
      apiId: 7,
      current: 1,
      required: 2,
    };
  await h.actions.launch(target, () => true);
  assert.equal(h.collector().expectedPlan.autoUpgrade, true);
  assert.deepEqual(h.collector().expectedMissing, [{ itemId: 55, amount: 1 }]);
  assert.equal(await h.actions.observe(target), "running");
});
test("does not replace an existing work goal", async () => {
  const h = fixture();
  h.entry.workFarm.start({ workId: 4, targetCycles: 8 });
  await assert.rejects(
    h.actions.launch(
      { kind: "boss", apiId: 17, current: 0, required: 1 },
      () => true,
    ),
    /floor_resources_busy/,
  );
  assert.equal(h.goal(), null);
});

test("does not start when character upgrades hold account resources", async () => {
  const h = fixture();
  h.entry.characterBatch = { running: () => true };
  await assert.rejects(
    h.actions.launch(
      { kind: "boss", apiId: 17, current: 0, required: 1 },
      () => true,
    ),
    /floor_resources_busy/,
  );
});
