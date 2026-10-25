import test from "node:test";
import assert from "node:assert/strict";
import { createBossBattleGoal } from "../src/features/bosses/BossBattle/boss-battle-goal.js";

function fixture(initial = {}, start = 1000) {
  let state = {
      boss: { id: "boss-1", name: "Boss" },
      battle: null,
      pending: null,
      ...initial,
    },
    time = start;
  const listeners = new Set();
  const controller = {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    controller,
    goal: () => createBossBattleGoal({ controller, now: () => time }),
    update(patch) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    setTime(n) {
      time = n;
    },
  };
}
const config = (kind = "battles", extra = {}) => ({
  bossId: "boss-1",
  bossName: "Boss",
  kind,
  targetCount: 2,
  ...extra,
});

test("validates variants and preserves configured goal on invalid input", () => {
  const g = fixture().goal();
  g.configure(config());
  const before = g.getSnapshot();
  for (const c of [
    config("wat"),
    config("battles", { targetCount: 0 }),
    config("business_items", { items: [] }),
    config("business_items", {
      items: [
        { key: "x", name: "X" },
        { key: "y", name: "Y" },
      ],
    }),
    config("drops", { items: [{ key: "x" }] }),
  ])
    assert.throws(() => g.configure(c));
  assert.equal(g.getSnapshot(), before);
});

test("battles counts confirmed terminal outcomes once and waits to exhaust cap", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(config("battles", { targetCount: 2, maxAttempts: 3 }));
  f.update({ battle: { id: "b1", status: "active" } });
  f.update({ battle: { id: "b1", status: "won" }, needsRefresh: true });
  assert.equal(g.getSnapshot().completedBattles, 0);
  f.update({ needsRefresh: false });
  f.update({ battle: { id: "b1", status: "won" } });
  assert.equal(g.getSnapshot().completedBattles, 1);
  assert.equal(g.getSnapshot().wins, 1);
  f.update({ battle: { id: "b2", status: "lost" } });
  assert.equal(g.getSnapshot().completedBattles, 2);
  assert.equal(g.getSnapshot().status, "completed");
});

test("adopts active battle and excludes terminal battle already present at configuration", () => {
  const a = fixture({ battle: { id: "live", status: "active" } }),
    ga = a.goal();
  ga.configure(config());
  assert.equal(ga.getSnapshot().attempts, 1);
  a.update({ battle: { id: "live", status: "lost" } });
  assert.equal(ga.getSnapshot().losses, 1);
  const e = fixture({ battle: { id: "old", status: "won" } }),
    ge = e.goal();
  ge.configure(config());
  assert.equal(ge.getSnapshot().attempts, 0);
  assert.equal(ge.getSnapshot().completedBattles, 0);
});

test("business item totals only selected identity receipts, with multi-drop aggregation", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(
    config("business_items", {
      targetCount: 5,
      items: [{ key: "item:7", name: "Widget" }],
    }),
  );
  f.update({
    battle: {
      id: "b1",
      status: "won",
      rewardKnown: true,
      grantedDrops: [
        { type: "item", itemId: 7, amount: 2 },
        { type: "item", itemId: 7, amount: 3 },
      ],
    },
  });
  assert.equal(g.getSnapshot().items[0].amount, 5);
  assert.equal(g.getSnapshot().status, "completed");
  f.update({
    battle: {
      id: "b1",
      status: "won",
      rewardKnown: true,
      grantedDrops: [{ type: "item", itemId: 7, amount: 5 }],
    },
  });
  assert.equal(g.getSnapshot().items[0].amount, 5);
});

test("drop goal requires each selected identity and ignores names", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(
    config("drops", {
      items: [
        { key: "item:7", name: "Same" },
        { key: "item:8", name: "Same" },
      ],
    }),
  );
  f.update({
    battle: {
      id: "b1",
      status: "won",
      rewardKnown: true,
      grantedDrops: [{ type: "item", itemId: 7, name: "Same", amount: 1 }],
    },
  });
  assert.equal(g.getSnapshot().progress, 1);
  assert.equal(g.getSnapshot().status, "active");
  f.update({
    battle: {
      id: "b2",
      status: "won",
      rewardKnown: true,
      grantedDrops: [{ type: "item", itemId: 8, amount: 1 }],
    },
  });
  assert.equal(g.getSnapshot().progress, 2);
  assert.equal(g.getSnapshot().status, "completed");
});

test("time deadline ticks, survives restore, and blocks starts at closure", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(config("time", { targetCount: undefined, durationHours: 1 }));
  const saved = g.exportState();
  f.setTime(3601000);
  g.tick();
  assert.equal(g.getSnapshot().status, "completed");
  assert.equal(g.canStart(), false);
  assert.equal(g.getSnapshot().remainingSeconds, 0);
  const restored = f.goal();
  restored.restoreState(saved);
  restored.tick();
  assert.equal(restored.getSnapshot().status, "completed");
});

test("duration deadlines expire quantitative goals and survive restore", () => {
  for (const kind of ["battles", "business_items", "drops"]) {
    const f = fixture();
    const g = f.goal();
    const extra =
      kind === "battles"
        ? {}
        : {
            items:
              kind === "business_items"
                ? [{ key: "item:7", name: "Widget" }]
                : [
                    { key: "item:7", name: "Widget" },
                    { key: "item:8", name: "Gadget" },
                  ],
          };
    g.configure(config(kind, { ...extra, durationHours: 1 }));
    f.update({ battle: { id: "battle-1", status: "lost" } });
    const deadline = g.getSnapshot().deadlineAt;
    assert.equal(deadline, 3601000);
    assert.equal(g.getSnapshot().status, "active");
    const saved = g.exportState();
    f.setTime(deadline);
    g.tick();
    assert.equal(g.getSnapshot().status, "expired");
    assert.equal(g.getSnapshot().canStart, false);
    assert.equal(g.getSnapshot().canContinue, false);

    const restored = f.goal();
    restored.restoreState(saved);
    restored.tick();
    assert.equal(restored.getSnapshot().deadlineAt, deadline);
    assert.equal(restored.getSnapshot().status, "expired");
  }
});

test("countWins goals count victories and have no implicit attempt cap", () => {
  const f = fixture();
  const g = f.goal();
  g.configure(config("battles", { targetCount: 2, countWins: true }));
  assert.equal(g.getSnapshot().countWins, true);
  assert.equal(g.getSnapshot().maxAttempts, null);
  assert.equal(g.exportState().settings.countWins, true);
  f.update({ battle: { id: "loss-1", status: "lost" } });
  assert.equal(g.getSnapshot().progress, 0);
  assert.equal(g.getSnapshot().status, "active");
  f.update({ battle: { id: "win-1", status: "won" } });
  assert.equal(g.getSnapshot().progress, 1);
  assert.equal(g.getSnapshot().status, "active");
  const restored = f.goal();
  restored.restoreState(g.exportState());
  assert.equal(restored.getSnapshot().countWins, true);
  assert.equal(restored.getSnapshot().maxAttempts, null);
  assert.equal(restored.getSnapshot().progress, 1);
});

test("canStart checks an elapsed deadline before a tick and finite time targets expose seconds", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(config("time", { targetCount: undefined, durationHours: 1 }));
  assert.equal(g.getSnapshot().target, 3600);
  f.setTime(3601000);
  assert.equal(g.canStart(), false);
});

test("drop target derives from unique selected keys and duplicate keys are rejected", () => {
  const f = fixture(),
    g = f.goal();
  assert.throws(() =>
    g.configure(
      config("drops", {
        items: [
          { key: "item:7", name: "A" },
          { key: "item:7", name: "B" },
        ],
      }),
    ),
  );
  g.configure(
    config("drops", {
      items: [
        { key: "item:7", name: "A" },
        { key: "item:8", name: "B" },
      ],
    }),
  );
  assert.equal(g.getSnapshot().target, 2);
});

test("unsafe receipt sums do not get credited", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(
    config("business_items", {
      targetCount: Number.MAX_SAFE_INTEGER,
      items: [{ key: "item:7", name: "Widget" }],
    }),
  );
  f.update({
    battle: {
      id: "b1",
      status: "won",
      rewardKnown: true,
      grantedDrops: [
        { type: "item", itemId: 7, amount: Number.MAX_SAFE_INTEGER },
        { type: "item", itemId: 7, amount: 1 },
      ],
    },
  });
  assert.equal(g.getSnapshot().items[0].amount, 0);
});

test("legacy victory goals migrate stopped and never autorun", () => {
  const g = fixture().goal();
  g.restoreState({
    settings: {
      bossId: "boss-1",
      bossName: "Boss",
      targetWins: 3,
      maxAttempts: 5,
    },
  });
  assert.equal(g.getSnapshot().kind, "battles");
  assert.equal(g.getSnapshot().targetCount, 3);
  assert.equal(g.getSnapshot().legacyMigration, true);
  assert.equal(g.getSnapshot().status, "stopped");
  assert.equal(g.canStart(), false);
});

test("does not add attempts after goal closure; reward uncertainty remains explicit", () => {
  const f = fixture(),
    g = f.goal();
  g.configure(config("battles", { targetCount: 1, maxAttempts: 2 }));
  f.update({ battle: { id: "b1", status: "won", rewardKnown: false } });
  assert.equal(g.getSnapshot().rewardUncertain, true);
  assert.equal(g.getSnapshot().status, "completed");
  f.update({ battle: { id: "b2", status: "active" } });
  assert.equal(g.getSnapshot().attempts, 1);
});
