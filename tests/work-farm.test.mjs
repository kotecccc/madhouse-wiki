import assert from "node:assert/strict";
import test from "node:test";
import { createWorkFarm } from "../scripts/automation/work-farm.mjs";

function makeHarness({
  completedCycles = 0,
  progress = [0],
  required = [1],
  energy = 10,
  maxEnergy = 10,
  regenIntervalSeconds = 60,
  secondsToNext = 0,
  energyCosts = [],
  boosters = { small: 0, full: 0 },
  restoreEnergy = { small: 2, full: 10 },
  prices = { small: 5, full: 20 },
  walletDollar = 100,
  holdPerform = false,
  losePerformReply = false,
  failReads = () => false,
  blockConfirmation = () => false,
  failBag = () => false,
  available = () => true,
  onProfileRead = () => {},
  loseBoosterReply = false,
  losePurchaseReply = false,
  onChange,
} = {}) {
  const workId = 7;
  const calls = [];
  const timers = [];
  let now = 1_000_000;
  let heldResolve;
  const tasks = required.map((count, index) => ({
    id: index + 1,
    title: `Task ${index + 1}`,
    required: count,
    progress: progress[index] ?? 0,
    energyCost: energyCosts[index] ?? 1,
  }));
  const game = {
    workId,
    title: "Test work",
    completedCycles,
    tasks,
    energy: { current: energy, max: maxEnergy },
    boosters: { ...boosters },
    walletDollar,
  };
  const definition = { workId, title: "Test work" };
  const boosterItems = () =>
    Object.fromEntries(
      ["small", "full"].map((type) => [
        type,
        {
          count: game.boosters[type],
          restoreEnergy: restoreEnergy[type],
          costDollar: prices[type],
          maxPurchaseQuantity: 10,
        },
      ]),
    );
  function stateResponse() {
    return {
      workId: game.workId,
      title: game.title,
      completedCycles: game.completedCycles,
      tasks: game.tasks.map((task) => ({
        ...task,
        canPerform:
          task.progress < task.required &&
          task.energyCost <= game.energy.current,
      })),
      energy: {
        current: game.energy.current,
        max: game.energy.max,
        regenIntervalSeconds,
        secondsToNext,
      },
      wallet: { dollar: game.walletDollar },
    };
  }
  const request = async (method, path, body = {}) => {
    calls.push({ method, path, body });
    if (blockConfirmation() && path === "/api/works/open")
      throw Object.assign(new Error("read was not dispatched"), {
        notDispatched: true,
      });
    if (path === "/api/me/bag" && failBag())
      throw new TypeError("inventory offline");
    if (path !== "/api/works/tasks/perform" && failReads())
      throw new TypeError("offline");
    if (path === "/api/works/open") return stateResponse();
    if (path === "/api/me") {
      onProfileRead();
      return {
        energy: {
          current: game.energy.current,
          max: game.energy.max,
          regenIntervalSeconds,
          secondsToNext,
        },
        wallet: { dollar: game.walletDollar },
      };
    }
    if (path === "/api/me/bag") return { boosters: boosterItems() };
    if (path === "/api/works/tasks/perform") {
      if (holdPerform)
        await new Promise((resolve) => {
          heldResolve = resolve;
        });
      const task = game.tasks.find((item) => item.id === body.taskId);
      assert.ok(task, "perform uses a known task id");
      task.progress++;
      game.energy.current -= task.energyCost;
      if (game.tasks.every((item) => item.progress >= item.required)) {
        game.completedCycles++;
        game.tasks.forEach((item) => {
          item.progress = 0;
        });
      }
      const result = stateResponse();
      if (losePerformReply) throw new TypeError("response connection lost");
      return result;
    }
    if (path === "/api/me/bag/boosters/use") {
      const type = body.type;
      assert.ok(game.boosters[type] > 0);
      game.boosters[type]--;
      game.energy.current = Math.min(game.energy.max, restoreEnergy[type]);
      if (loseBoosterReply) throw new TypeError("reply lost");
      return { success: true, energy: { ...game.energy } };
    }
    if (path === "/api/me/bag/boosters/buy") {
      assert.ok(game.walletDollar >= prices[body.type]);
      game.walletDollar -= prices[body.type] * body.quantity;
      game.boosters[body.type] += body.quantity;
      if (losePurchaseReply) throw new TypeError("purchase reply lost");
      return { success: true, wallet: { dollar: game.walletDollar } };
    }
    throw new Error(`Unexpected fake route: ${method} ${path}`);
  };
  const farm = createWorkFarm({
    request,
    onChange,
    available,
    getWork: (id) => (id === workId ? definition : null),
    now: () => now,
    random: () => 0,
    schedule: (callback, delay) => {
      const timer = { callback, delay, at: now + delay, canceled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.canceled = true;
    },
  });
  async function flush() {
    for (let index = 0; index < 20; index++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 10; index++) await Promise.resolve();
  }
  async function fireNext({ advance = true } = {}) {
    const timer = timers.find((item) => !item.canceled);
    assert.ok(timer, "a timer is queued");
    timer.canceled = true;
    if (advance) now = Math.max(now, timer.at);
    timer.callback();
    await flush();
    return timer;
  }
  return {
    farm,
    game,
    calls,
    request,
    timers,
    flush,
    fireNext,
    setNow(value) {
      now = value;
    },
    releasePerform() {
      heldResolve?.();
    },
  };
}

async function refresh(harness) {
  await harness.farm.refresh(7);
}

test("manual refresh retry persists a 60 second cooldown before game I/O", async () => {
  const h = makeHarness();
  await h.farm.refresh(7, { manual: true });
  const callsAfterFirst = h.calls.length;
  const retryAt = h.farm.exportState().refreshRetryAt;
  assert.equal(retryAt, 1_060_000);
  await assert.rejects(
    h.farm.refresh(7, { manual: true }),
    /Повторное обновление доступно через 60 сек\./,
  );
  assert.equal(
    h.calls.length,
    callsAfterFirst,
    "cooldown rejects before any game request",
  );
  const restored = createWorkFarm({
    saved: h.farm.exportState(),
    request: h.request,
    getWork: () => ({ workId: 7 }),
    now: () => 1_030_000,
  });
  await assert.rejects(
    restored.refresh(7, { manual: true }),
    /доступно через 30 сек\./,
  );
  assert.equal(h.calls.length, callsAfterFirst);
});

function start(farm, args = {}) {
  farm.start({
    ...(args.mode === "energy" && farm.getSnapshot().view
      ? { energyBudget: farm.getSnapshot().view.energy.current }
      : {}),
    workId: 7,
    targetCycles: 1,
    maxActions: 100,
    durationHours: 1,
    mode: "wait",
    maxBoosters: 0,
    allowPurchase: false,
    maxDollar: 0,
    ...args,
  });
}

test("suspending work before an action preserves its run and resumes once", async () => {
  const h = makeHarness({ required: [2] });
  await refresh(h);
  start(h.farm);
  const before = structuredClone(h.farm.exportState());
  assert.equal(h.farm.suspend(), true);
  assert.deepEqual(h.farm.exportState(), before);
  assert.equal(h.timers.filter((timer) => !timer.canceled).length, 0);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    0,
  );
  h.farm.resume();
  await h.fireNext({ advance: false });
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
  h.farm.stop();
});

test("work cannot be suspended while an action response is unresolved", async () => {
  const h = makeHarness({ required: [2], holdPerform: true });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  assert.equal(h.farm.suspend(), false);
  assert.equal(h.farm.getSnapshot().run.pending.kind, "performing");
  h.releasePerform();
  await h.flush();
  h.farm.stop();
});

test("reopening active work progress uses the runner checkpoint without extra reads", async () => {
  const h = makeHarness({ required: [3], holdPerform: true });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  const before = structuredClone(h.farm.exportState());
  const calls = h.calls.length;
  assert.equal(before.run.pending.kind, "performing");
  await h.farm.refresh(7);
  await h.farm.refresh(7, { manual: true });
  assert.equal(h.calls.length, calls);
  assert.deepEqual(h.farm.exportState(), before);
  await assert.rejects(h.farm.refresh(8), /Сначала остановите фарм/);
  h.releasePerform();
  await h.flush();
  h.farm.stop();
});

test("fresh partial progress and existing cycles reach a total-cycle target without an extra task", async () => {
  const h = makeHarness({
    completedCycles: 4,
    progress: [1, 0],
    required: [2, 1],
    energy: 10,
  });
  await refresh(h);
  start(h.farm, { targetCycles: 5 });
  await h.fireNext({ advance: false });
  await h.fireNext({ advance: false });
  const run = h.farm.getSnapshot().run;
  assert.equal(run.status, "completed", run.reason);
  assert.equal(run.completedCycles, 5);
  assert.equal(run.actionsDone, 2);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    2,
  );
  assert.equal(h.game.completedCycles, 5);
});

test("energy mode spends only the captured budget, including partial cycles, without refills or waits", async () => {
  const h = makeHarness({
    required: [2, 1],
    energyCosts: [3, 1],
    energy: 2,
    maxEnergy: 10,
    boosters: { small: 2, full: 2 },
  });
  await refresh(h);
  const bagCallsBeforeStart = h.calls.filter(
    (call) => call.path === "/api/me/bag",
  ).length;
  start(h.farm, {
    mode: "energy",
    targetCycles: 100,
    maxActions: 10,
    maxBoosters: 8,
    maxDollar: 100,
    allowPurchase: true,
  });
  assert.equal(h.farm.getSnapshot().run.energyBudget, 2);
  assert.equal(h.farm.getSnapshot().run.config.energyBudget, 2);
  await h.fireNext({ advance: false });
  assert.equal(
    h.game.tasks[1].progress,
    1,
    "chooses the affordable task in task order",
  );
  await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.energySpent, 1);
  assert.equal(h.game.completedCycles, 0, "does not require a complete cycle");
  assert.equal(
    h.calls.filter((call) => call.path.startsWith("/api/me/bag/boosters/"))
      .length,
    0,
  );
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
  assert.equal(
    h.calls.filter((call) => call.path === "/api/me/bag").length,
    bagCallsBeforeStart,
  );
});

test("energy regeneration cannot expand the initial energy budget", async () => {
  const h = makeHarness({
    required: [3],
    energyCosts: [2],
    energy: 3,
    maxEnergy: 10,
  });
  await refresh(h);
  start(h.farm, { mode: "energy", targetCycles: 1, maxActions: 10 });
  await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.energySpent, 2);
  h.game.energy.current = 10;
  await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.energySpent, 2);
  assert.equal(h.game.tasks[0].progress, 1);
});

test("energy mode keeps the uncertain mutation checkpoint and does not replay it", async () => {
  const h = makeHarness({
    required: [2],
    energyCosts: [2],
    energy: 4,
    losePerformReply: true,
  });
  await refresh(h);
  start(h.farm, { mode: "energy", targetCycles: 10 });
  await h.fireNext({ advance: false });
  const saved = structuredClone(h.farm.exportState());
  assert.equal(saved.run.status, "running");
  assert.equal(saved.run.pending.kind, "performing");
  assert.equal(saved.run.energyBudget, 4);
  assert.equal(saved.run.energySpent, 0);
  const restored = createWorkFarm({
    saved,
    request: h.request,
    now: () => 1_000_000,
    getWork: () => ({ workId: 7 }),
    schedule: () => null,
    cancel: () => {},
  });
  restored.resume();
  await h.flush();
  assert.equal(restored.getSnapshot().run.status, "running");
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
});

test("booster use and purchase are verified against inventory and wallet within limits", async () => {
  const h = makeHarness({
    required: [1],
    energy: 0,
    maxEnergy: 2,
    boosters: { small: 1, full: 0 },
    restoreEnergy: { small: 2, full: 2 },
    prices: { small: 5, full: 20 },
    walletDollar: 5,
  });
  await refresh(h);
  start(h.farm, {
    targetCycles: 3,
    maxActions: 6,
    mode: "boosters",
    maxBoosters: 2,
    allowPurchase: true,
    maxDollar: 5,
  });
  for (let index = 0; index < 10 && h.farm.running(); index++)
    await h.fireNext({ advance: false });
  const run = h.farm.getSnapshot().run;
  assert.equal(run.status, "completed", run.reason);
  assert.equal(run.usedBoosters, 2);
  assert.equal(run.spentDollar, 5);
  assert.equal(run.actionsDone, 6);
  assert.equal(h.game.walletDollar, 0);
  assert.equal(h.game.boosters.small, 0);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/me/bag/boosters/use").length,
    2,
  );
  assert.equal(
    h.calls.filter((call) => call.path === "/api/me/bag/boosters/buy").length,
    1,
  );
});

test("lost perform reply is reconciled by reading progress and completes without replay", async () => {
  const h = makeHarness({ required: [1], losePerformReply: true });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  const run = h.farm.getSnapshot().run;
  assert.equal(run.status, "running");
  assert.equal(run.phase, "reconciling");
  assert.equal(run.pending.kind, "performing");
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.energySpent, 1);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
});

test("stop during a held task request prevents the queued next action", async () => {
  const h = makeHarness({ required: [2], holdPerform: true });
  await refresh(h);
  start(h.farm);
  const initialTimer = h.timers.find((item) => !item.canceled);
  initialTimer.canceled = true;
  initialTimer.callback();
  await h.flush();
  assert.equal(h.farm.getSnapshot().run.pending.kind, "performing");
  h.farm.stop();
  h.releasePerform();
  await h.flush();
  for (const timer of h.timers.filter((item) => !item.canceled)) {
    timer.canceled = true;
    timer.callback();
  }
  await h.flush();
  assert.equal(h.farm.getSnapshot().run.status, "stopped");
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
});

test("legacy pending checkpoint keeps intent without replaying mutations", async () => {
  const h = makeHarness();
  const pendingFarm = createWorkFarm({
    saved: {
      view: null,
      run: {
        workId: 7,
        status: "running",
        phase: "performing",
        deadlineAt: 9_000_000,
        pending: { kind: "performing", operationId: "old-action" },
      },
    },
    request: h.request,
    getWork: () => ({ workId: 7 }),
    now: () => 1_000_000,
    schedule: () => null,
    cancel: () => {},
  });
  pendingFarm.resume();
  assert.equal(pendingFarm.getSnapshot().run.status, "running");
  assert.equal(h.calls.length, 0);
});

test("wait mode schedules from secondsToNext and measured regeneration interval", async () => {
  const h = makeHarness({
    required: [1],
    energyCosts: [3],
    energy: 0,
    maxEnergy: 5,
    regenIntervalSeconds: 60,
    secondsToNext: 10,
  });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  const timer = h.timers.find((item) => !item.canceled);
  assert.equal(h.farm.getSnapshot().run.phase, "waiting");
  assert.equal(timer.delay, 130_000);
  assert.equal(h.farm.getSnapshot().run.nextActionAt, 1_130_000);
});

test("duration deadline and action cap terminate without extra mutations", async () => {
  const deadline = makeHarness({ required: [2], energy: 0, maxEnergy: 2 });
  await refresh(deadline);
  start(deadline.farm, { maxActions: 2, durationHours: 1 });
  await deadline.fireNext({ advance: false });
  deadline.setNow(deadline.farm.getSnapshot().run.deadlineAt);
  deadline.farm.tick();
  assert.equal(deadline.farm.getSnapshot().run.status, "limited");
  assert.equal(
    deadline.calls.filter((call) => call.path === "/api/works/tasks/perform")
      .length,
    0,
  );

  const capped = makeHarness({ required: [2], energy: 2, maxEnergy: 2 });
  await refresh(capped);
  start(capped.farm, { targetCycles: 1, maxActions: 1 });
  await capped.fireNext({ advance: false });
  await capped.fireNext({ advance: false });
  assert.equal(capped.farm.getSnapshot().run.status, "limited");
  assert.equal(
    capped.farm.getSnapshot().run.reason,
    "Достигнут лимит игровых действий.",
  );
  assert.equal(
    capped.calls.filter((call) => call.path === "/api/works/tasks/perform")
      .length,
    1,
  );
});

test("energy mode clamps its budget to fresh energy before the first action", async () => {
  const h = makeHarness({ required: [10], energy: 5, maxEnergy: 10 });
  await refresh(h);
  start(h.farm, { mode: "energy" });
  h.game.energy.current = 2;
  await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.energyBudget, 2);
  h.game.energy.current = 10;
  for (let index = 0; index < 5 && h.farm.running(); index++)
    await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.energySpent, 2);
  assert.equal(h.farm.getSnapshot().run.status, "completed");
});

test("outage before first read queues a new energy goal and recovers automatically", async () => {
  let offline = true;
  const h = makeHarness({ required: [2], energy: 2, failReads: () => offline });
  start(h.farm, { mode: "energy" });
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.phase, "retrying");
  assert.equal(h.farm.getSnapshot().run.energyBudget, null);
  offline = false;
  for (let index = 0; index < 4 && h.farm.running(); index++)
    await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.energySpent, 2);
  assert.equal(h.game.completedCycles, 1);
});

test("work yields to combat and resumes after the priority action", async () => {
  let combat = true;
  const h = makeHarness({ available: () => !combat });
  await refresh(h);
  start(h.farm);
  const count = h.calls.length;
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.phase, "queued");
  assert.equal(h.calls.length, count);
  combat = false;
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
});

test("temporary inventory failure waits instead of treating unknown boosters as exhausted resources", async () => {
  let offline = true;
  const h = makeHarness({
    energy: 0,
    boosters: { small: 1, full: 0 },
    failBag: () => offline,
  });
  await refresh(h);
  start(h.farm, { mode: "boosters", maxBoosters: 1 });
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.phase, "retrying");
  assert.equal(h.farm.getSnapshot().run.actionsDone, 0);
  offline = false;
  for (let i = 0; i < 4 && h.farm.running(); i++) await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.usedBoosters, 1);
});

test("fresh caller budget and fresh game energy override a stale work view before MAX farming", async () => {
  const h = makeHarness({ required: [20], energy: 1, maxEnergy: 20 });
  await refresh(h);
  h.game.energy.current = 16;
  start(h.farm, { mode: "energy", energyBudget: 16 });
  for (let i = 0; i < 20 && h.farm.running(); i++) await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.energySpent, 16);
  assert.equal(h.farm.getSnapshot().run.usedBoosters, 0);
});

test("a queued MAX intent without an explicit budget captures live energy rather than a stale saved view", async () => {
  const h = makeHarness({ required: [20], energy: 1, maxEnergy: 20 });
  await refresh(h);
  h.game.energy.current = 4;
  start(h.farm, { mode: "energy", energyBudget: null });
  for (let i = 0; i < 8 && h.farm.running(); i++) await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.energyBudget, 4);
  assert.equal(h.farm.getSnapshot().run.energySpent, 4);
});

test("a priority action beginning during work reads defers its mutation until the action completes", async () => {
  let combat = false,
    armed = false;
  const h = makeHarness({
    available: () => !combat,
    onProfileRead: () => {
      if (armed) combat = true;
    },
  });
  await refresh(h);
  start(h.farm);
  armed = true;
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.phase, "queued");
  assert.equal(h.farm.getSnapshot().run.actionsDone, 0);
  assert.equal(
    h.calls.some((c) => c.path === "/api/works/tasks/perform"),
    false,
  );
  combat = false;
  armed = false;
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
});

test("manual refill uses one owned booster, persists intent before POST and never purchases", async () => {
  const records = [];
  const h = makeHarness({
    energy: 0,
    boosters: { small: 2, full: 0 },
    onChange: () => records.push(structuredClone(h.farm.exportState())),
  });
  await h.farm.useBooster(7, "small");
  assert.equal(h.game.boosters.small, 1);
  assert.equal(h.game.energy.current, 2);
  assert.equal(h.farm.getSnapshot().manualPending, null);
  assert.ok(
    records.some(
      (record) =>
        record.manualPending?.type === "small" &&
        record.manualPending.count === 2,
    ),
  );
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boosters/use")).length,
    1,
  );
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boosters/buy")).length,
    0,
  );
  await assert.rejects(h.farm.useBooster(7, "small"));
  assert.equal(h.game.boosters.small, 1);
});

test("lost manual refill response survives restart and reconciles with reads without replay", async () => {
  const h = makeHarness({
    energy: 0,
    boosters: { small: 2, full: 0 },
    loseBoosterReply: true,
  });
  await assert.rejects(h.farm.useBooster(7, "small"));
  const saved = structuredClone(h.farm.exportState());
  assert.ok(saved.manualPending);
  const restored = createWorkFarm({
    saved,
    request: h.request,
    getWork: () => ({ workId: 7 }),
  });
  await assert.rejects(restored.useBooster(7, "small"));
  assert.throws(() => start(restored), /уже запущен|запрос/);
  await restored.refresh(7);
  assert.equal(restored.getSnapshot().manualPending, null);
  assert.equal(h.game.boosters.small, 1);
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boosters/use")).length,
    1,
  );
});

test("blocked confirmation read preserves the submitted booster checkpoint", async () => {
  let block = true;
  const h = makeHarness({
    energy: 0,
    boosters: { small: 2, full: 0 },
    blockConfirmation: () =>
      block && h.calls.some((call) => call.path.endsWith("boosters/use")),
  });
  await assert.rejects(
    h.farm.useBooster(7, "small", { commandId: "booster-confirmation" }),
    /read was not dispatched/,
  );
  const saved = structuredClone(h.farm.exportState());
  assert.equal(saved.manualPending.commandId, "booster-confirmation");
  const restored = createWorkFarm({
    saved,
    request: h.request,
    getWork: () => ({ workId: 7 }),
  });
  await assert.rejects(restored.useBooster(7, "small"));
  block = false;
  await restored.refresh(7);
  assert.equal(restored.getSnapshot().manualPending, null);
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boosters/use")).length,
    1,
  );
});

test("manual refill checks priority again after reading and never dispatches when unavailable", async () => {
  let available = true;
  const h = makeHarness({
    energy: 0,
    boosters: { small: 1, full: 0 },
    available: () => available,
    onProfileRead: () => {
      available = false;
    },
  });
  await assert.rejects(h.farm.useBooster(7, "small"));
  assert.equal(
    h.calls.filter((call) => call.path.endsWith("boosters/use")).length,
    0,
  );
  assert.equal(h.farm.getSnapshot().manualPending, null);
});

test("an outage after a lost refill response preserves the checkpoint and consumes only one booster", async () => {
  let offline = false;
  const h = makeHarness({
    required: [1],
    energy: 0,
    maxEnergy: 2,
    boosters: { small: 1, full: 0 },
    restoreEnergy: { small: 2, full: 2 },
    loseBoosterReply: true,
    failReads: () => offline,
  });
  await refresh(h);
  start(h.farm, {
    mode: "boosters",
    targetCycles: 1,
    maxBoosters: 1,
    allowPurchase: false,
    maxDollar: 0,
  });
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.pending?.kind, "refilling");
  assert.equal(h.game.boosters.small, 0);
  offline = true;
  await h.fireNext();
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "running");
  assert.equal(h.farm.getSnapshot().run.pending?.kind, "refilling");
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/use")).length,
    1,
  );
  offline = false;
  for (let i = 0; i < 5 && h.farm.running(); i++) await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.usedBoosters, 1);
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/use")).length,
    1,
  );
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/buy")).length,
    0,
  );
});

test("a lost purchase reply followed by an outage never buys a second booster", async () => {
  let offline = false;
  const h = makeHarness({
    energy: 0,
    maxEnergy: 2,
    boosters: { small: 0, full: 0 },
    restoreEnergy: { small: 2, full: 2 },
    prices: { small: 5, full: 20 },
    walletDollar: 5,
    losePurchaseReply: true,
    failReads: () => offline,
  });
  await refresh(h);
  start(h.farm, {
    mode: "boosters",
    targetCycles: 1,
    maxBoosters: 1,
    allowPurchase: true,
    maxDollar: 5,
  });
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.pending?.kind, "buying");
  assert.equal(h.game.walletDollar, 0);
  offline = true;
  await h.fireNext();
  await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "running");
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/buy")).length,
    1,
  );
  offline = false;
  for (let i = 0; i < 6 && h.farm.running(); i++) await h.fireNext();
  assert.equal(h.farm.getSnapshot().run.status, "completed");
  assert.equal(h.farm.getSnapshot().run.spentDollar, 5);
  assert.equal(h.game.walletDollar, 0);
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/buy")).length,
    1,
  );
  assert.equal(
    h.calls.filter((c) => c.path.endsWith("boosters/use")).length,
    1,
  );
});

test("pausing and immediately resuming an in-flight work action reconciles it before continuing", async () => {
  const h = makeHarness({ required: [2], holdPerform: true });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  assert.equal(h.farm.getSnapshot().run.pending.kind, "performing");
  const firstId = h.farm.getSnapshot().run.pending.operationId;
  assert.equal(h.farm.pause(), true);
  assert.equal(h.farm.getSnapshot().run.status, "paused");
  assert.equal(h.farm.canSuspend(), false);
  assert.throws(() => start(h.farm), /Фарм уже запущен/);
  assert.equal(h.farm.resumePaused(), true);
  h.releasePerform();
  await h.flush();
  assert.equal(h.farm.getSnapshot().run.pending.kind, "performing");
  await h.fireNext({ advance: false });
  assert.notEqual(h.farm.getSnapshot().run.pending.operationId, firstId);
  assert.equal(h.farm.getSnapshot().run.pending.before.tasks[0].progress, 1);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    2,
  );
  assert.equal(h.game.tasks[0].progress, 1);
  h.farm.stop();
  h.releasePerform();
  await h.flush();
});

test("a paused farm survives restart and remains stopped until resumed", async () => {
  const h = makeHarness({ required: [2] });
  await refresh(h);
  start(h.farm);
  h.farm.pause();
  const saved = structuredClone(h.farm.exportState());
  h.farm.dispose();
  const timers = [];
  const restored = createWorkFarm({
    saved,
    request: h.request,
    getWork: () => ({ workId: 7 }),
    now: () => 1_000_000,
    schedule: (callback) => {
      timers.push(callback);
      return callback;
    },
    cancel: () => {},
  });
  restored.resume();
  assert.equal(restored.getSnapshot().run.status, "paused");
  assert.equal(timers.length, 0);
  assert.equal(restored.resumePaused(), true);
  assert.equal(restored.getSnapshot().run.status, "running");
  assert.equal(timers.length, 1);
  restored.stop();
});

test("a stopped in-flight work action is reconciled by reads without resuming the farm", async () => {
  const h = makeHarness({ required: [2], holdPerform: true });
  await refresh(h);
  start(h.farm);
  await h.fireNext({ advance: false });
  h.farm.stop();
  assert.equal(h.farm.canSuspend(), false);
  h.releasePerform();
  await h.flush();
  h.farm.tick();
  await h.flush();
  assert.equal(h.farm.getSnapshot().run.status, "stopped");
  assert.equal(h.farm.getSnapshot().run.pending, null);
  assert.equal(h.farm.canSuspend(), true);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/works/tasks/perform").length,
    1,
  );
  assert.equal(h.timers.filter((timer) => !timer.canceled).length, 0);
});

test("legacy uncertain booster is reconciled automatically without another use", async () => {
  const h = makeHarness({
    boosters: { small: 1, full: 0 },
    energy: 0,
    loseBoosterReply: true,
  });
  await assert.rejects(h.farm.useBooster(7, "small"));
  assert.ok(h.farm.getSnapshot().manualPending);
  h.farm.tick();
  await h.flush();
  assert.equal(h.farm.getSnapshot().manualPending, null);
  assert.equal(
    h.calls.filter((call) => call.path === "/api/me/bag/boosters/use").length,
    1,
  );
});
