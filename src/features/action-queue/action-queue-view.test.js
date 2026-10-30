import { test } from "node:test";
import assert from "node:assert/strict";
import { actionQueueCards } from "./action-queue-view.js";

test("a paused unsent retry budget offers an explicit resume and cancellation", () => {
  const [card] = actionQueueCards({
    serverTime: 1000,
    queuedActions: [
      {
        id: "retry-job",
        type: "inventory",
        status: "paused",
        reason: "unsent_retry_budget",
        createdAt: 1,
        args: { type: "weapon", id: 1, action: "buy" },
      },
    ],
  });
  assert.equal(card.status, "Нужна повторная попытка");
  assert.equal(card.pauseCommand, "queue.resume");
  assert.equal(card.command, "queue.cancel");
});

test("explains an unresolved stopped work action and the rejected unsent job", () => {
  const cards = actionQueueCards({
    serverTime: 100,
    workFarm: {
      run: {
        status: "stopped",
        phase: "reconciling",
        pending: { kind: "performing" },
        reconcileFailures: 5,
        workId: 7,
      },
    },
    queuedActions: [
      {
        id: "equip-job",
        type: "inventory",
        status: "failed",
        reason: "work_result_unresolved",
        args: { type: "pet", id: 55, action: "equip" },
        createdAt: 1,
      },
    ],
  });
  assert.equal(
    cards.find((card) => card.id === "work").status,
    "Результат не подтверждён",
  );
  assert.equal(
    cards.find((card) => card.id === "equip-job").status,
    "Результат прежней работёнки не подтверждён",
  );
  assert.equal(
    cards.find((card) => card.id === "equip-job").command,
    "queue.dismiss",
  );
});

test("projects server actors and prioritized queued intentions without duplicate battle card", () => {
  const state = {
    serverTime: 100000,
    raid: { enabled: true },
    auto: { enabled: true },
    workFarm: { run: { status: "running", phase: "waiting", workId: 1 } },
    queuedActions: [
      {
        id: "low",
        type: "inventory",
        status: "queued",
        priority: 1,
        createdAt: 100,
        args: { type: "weapon", id: 1, action: "buy" },
      },
      {
        id: "high",
        type: "inventory",
        status: "queued",
        priority: 3,
        createdAt: 200,
        args: { type: "weapon", id: 2, action: "equip" },
      },
      {
        id: "hidden",
        type: "inventory",
        status: "completed",
        dismissed: true,
        priority: 4,
        createdAt: 100,
        args: {},
      },
    ],
  };
  const cards = actionQueueCards(state, {
    inventoryItems: [{ id: "2", type: "weapon", name: "Клинок" }],
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["raid", "work", "high", "low"],
  );
  assert.equal(cards[1].status, "Ожидает энергию");
  assert.equal(cards[2].title, "Клинок");
  assert.deepEqual(cards[2].inventoryTarget, { type: "weapon", id: 2 });
  assert.equal(cards[2].position, 1);
  assert.equal(cards[3].position, 2);
});

test("completed actions disappear while handoffs do not claim the goal finished", () => {
  const cards = actionQueueCards({
    serverTime: 1000,
    queuedActions: [
      {
        id: "done",
        type: "inventory",
        status: "completed",
        priority: 30,
        createdAt: 1,
        args: { action: "buy" },
      },
      {
        id: "handoff",
        type: "work.start",
        status: "completed",
        priority: 20,
        createdAt: 2,
        args: { workId: 1 },
      },
    ],
  });
  const done = cards.find((card) => card.id === "done");
  const handoff = cards.find((card) => card.id === "handoff");
  assert.equal(done, undefined);
  assert.equal(handoff.status, "Передано исполнителю");
  assert.equal(handoff.command, "queue.dismiss");
});

test("stopped battle handoffs are hidden while subscription handoffs remain visible", () => {
  for (const [type, actorName] of [
    ["auto.start", "auto"],
    ["raid.start", "raid"],
    ["subscription.start", "subscription"],
  ]) {
    const job = {
      id: "handoff-01",
      type,
      status: "completed",
      priority: 15,
      createdAt: 1,
      args: {},
    };
    const state = {
      [actorName]: { queueId: job.id, enabled: false },
      queuedActions: [job],
    };
    const cards = actionQueueCards(state);
    if (type !== "subscription.start") {
      assert.equal(cards.length, 0);
      continue;
    }
    assert.equal(cards.length, 1);
    assert.equal(cards[0].id, job.id);
    assert.equal(cards[0].status, "Передано исполнителю");
    assert.equal(cards[0].command, "queue.dismiss");
    state[actorName].enabled = true;
    assert.ok(!actionQueueCards(state).some((card) => card.id === job.id));
  }
});

test("a stopped subscription handoff remains visible beyond recent completions", () => {
  for (const [type, actorName] of [["subscription.start", "subscription"]]) {
    const job = {
      id: "old-handoff",
      type,
      status: "completed",
      priority: 15,
      createdAt: 1,
      finishedAt: 1,
      args: {},
    };
    const later = Array.from({ length: 6 }, (_, i) => ({
      id: `later-${i}`,
      type: "inventory",
      status: "completed",
      priority: 30,
      createdAt: i + 2,
      finishedAt: i + 2,
      args: { action: "buy" },
    }));
    const state = {
      [actorName]: { queueId: job.id, enabled: false },
      queuedActions: [job, ...later],
    };
    const card = actionQueueCards(state).find((item) => item.id === job.id);
    assert.equal(card.status, "Передано исполнителю");
    assert.equal(card.command, "queue.dismiss");
    job.dismissed = true;
    assert.ok(!actionQueueCards(state).some((item) => item.id === job.id));
  }
});

test("completed one-off actions are hidden regardless of completion time", () => {
  const completed = Array.from({ length: 6 }, (_, index) => ({
    id: `done-${index}`,
    type: "inventory",
    status: "completed",
    priority: 0,
    createdAt: index + 1,
    finishedAt: index === 0 ? 100 : index + 10,
    args: { action: "buy" },
  }));
  const ids = actionQueueCards({
    serverTime: 200,
    queuedActions: completed,
  }).map((card) => card.id);
  assert.deepEqual(ids, []);
});

test("a finished long-running actor reports its own outcome and can be dismissed", () => {
  for (const [type, field, status, expected] of [
    ["work.start", "workFarm", "completed", "Выполнено"],
    ["work.start", "workFarm", "limited", "Достигнут лимит"],
    ["business.start", "businessAssistant", "error", "Не удалось выполнить"],
    ["character.start", "characterUpgrade", "stopped", "Остановлено"],
  ]) {
    const run = { queueId: "goal-01", status };
    const cards = actionQueueCards({
      serverTime: 1000,
      [field]: { run },
      queuedActions: [
        {
          id: "goal-01",
          type,
          status: "completed",
          priority: 0,
          createdAt: 1,
          args: {},
        },
      ],
    });
    if (status === "completed") {
      assert.deepEqual(cards, []);
    } else {
      assert.equal(cards.length, 1);
      assert.equal(cards[0].status, expected);
      assert.equal(cards[0].command, "queue.dismiss");
    }
  }
});

test("a stopped floor runner retains a dismissible outcome", () => {
  const cards = actionQueueCards({
    floorRunner: { queueId: "floor-job", status: "stopped", target: null },
    queuedActions: [
      {
        id: "floor-job",
        type: "floor.start",
        status: "completed",
        priority: 0,
        createdAt: 1,
        args: {},
      },
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "Остановлено");
  assert.equal(cards[0].command, "queue.dismiss");
});

test("a floor checkpoint shows the server's reason for an uncertain launch", () => {
  const reason =
    "Запуск цели не подтверждён после перезапуска. Проверьте состояние перед продолжением.";
  const [card] = actionQueueCards({
    floorRunner: { status: "paused", phase: "launching", reason },
  });
  assert.equal(card.status, reason);
  assert.equal(card.command, "floor.stop");
});

test("a stopped work actor with an unresolved checkpoint remains on reconciliation", () => {
  const cards = actionQueueCards({
    workFarm: {
      run: {
        queueId: "goal-01",
        status: "stopped",
        pending: { id: "unknown" },
      },
    },
    queuedActions: [
      {
        id: "goal-01",
        type: "work.start",
        status: "completed",
        priority: 0,
        createdAt: 1,
        args: {},
      },
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "Проверяем результат");
  assert.equal(cards[0].command, null);
});

test("a dependent action explains that it waits for confirmation", () => {
  const [card] = actionQueueCards({
    serverTime: 1000,
    queuedActions: [
      {
        id: "dependent",
        type: "inventory",
        status: "queued",
        priority: 30,
        createdAt: 1,
        args: { action: "buy" },
        blockedBy: "dependency",
        eligible: false,
      },
    ],
  });
  assert.equal(card.status, "Ожидает подтверждения действия");
  assert.equal(card.position, null);
});

test("a failed prerequisite is shown even when the session needs login", () => {
  const [card] = actionQueueCards({
    serverTime: 1000,
    gameHealth: { status: "credentials_invalid" },
    queuedActions: [
      {
        id: "dependent",
        type: "inventory",
        status: "failed",
        reason: "dependency_failed",
        priority: 30,
        createdAt: 1,
        args: { action: "buy" },
      },
    ],
  });
  assert.equal(card.status, "Предыдущее действие не выполнено");
});

test("a cancelled in-flight action that fails shows its final error and can be dismissed", () => {
  const cards = actionQueueCards({
    gameHealth: { status: "credentials_invalid" },
    queuedActions: [
      {
        id: "failed-after-cancel",
        type: "inventory",
        args: { action: "buy" },
        priority: 1,
        createdAt: 1,
        status: "failed",
        cancelRequested: true,
        reason: "inventory_price_changed",
      },
    ],
  });
  assert.equal(cards[0].status, "Цена изменилась");
  assert.equal(cards[0].command, "queue.dismiss");
  assert.equal(cards[0].cancelNotice, null);
});

test("retry deadlines are shown only when a future attempt or reconciliation is scheduled", () => {
  const base = {
    type: "inventory",
    priority: 0,
    createdAt: 1,
    args: { action: "buy" },
  };
  const cards = actionQueueCards({
    serverTime: 1000,
    queuedActions: [
      { ...base, id: "retry", status: "waiting", nextAt: 2000 },
      { ...base, id: "reconcile", status: "reconciling", nextAt: 3000 },
      { ...base, id: "past", status: "waiting", nextAt: 1000 },
      { ...base, id: "unknown", status: "waiting", nextAt: null },
      {
        ...base,
        id: "dependent",
        status: "waiting",
        nextAt: 3000,
        blockedBy: "dependency",
      },
      { ...base, id: "invalid", status: "waiting", nextAt: 9e15 },
      { ...base, id: "done", status: "completed", nextAt: 3000 },
    ],
  });
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  assert.equal(byId.retry.retryAt, 2000);
  assert.equal(byId.retry.retryIsReconciliation, false);
  assert.equal(byId.reconcile.retryAt, 3000);
  assert.equal(byId.reconcile.retryIsReconciliation, true);
  for (const id of ["past", "unknown", "dependent", "invalid"])
    assert.equal(byId[id].retryAt, null);
  assert.equal(byId.done, undefined);
});

test("the retry lower bound includes the shared cooldown without promising dependency readiness", () => {
  const base = {
    type: "inventory",
    priority: 0,
    createdAt: 1,
    args: { action: "buy" },
  };
  const cards = actionQueueCards({
    serverTime: 1000,
    queueNotBefore: 5000,
    queuedActions: [
      {
        ...base,
        id: "shared",
        status: "waiting",
        nextAt: 2000,
        blockedBy: "game",
      },
      {
        ...base,
        id: "later",
        status: "reconciling",
        nextAt: 7000,
        blockedBy: "rate",
      },
      {
        ...base,
        id: "queued",
        status: "queued",
        nextAt: 1000,
        blockedBy: "rate",
      },
      {
        ...base,
        id: "dependency",
        status: "waiting",
        nextAt: 2000,
        blockedBy: "dependency",
      },
    ],
  });
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  assert.equal(byId.shared.retryAt, 5000);
  assert.equal(byId.later.retryAt, 7000);
  assert.equal(byId.queued.retryAt, 5000);
  assert.equal(byId.dependency.retryAt, null);
});

test("a cancellable running or uncertain action explains what can happen after removal", () => {
  const base = {
    type: "inventory",
    priority: 0,
    createdAt: 1,
    args: { action: "buy" },
  };
  const cards = actionQueueCards({
    queuedActions: [
      { ...base, id: "running", status: "running" },
      { ...base, id: "uncertain", status: "reconciling" },
      { ...base, id: "waiting", status: "waiting" },
      {
        ...base,
        id: "cancelled-request",
        status: "reconciling",
        cancelRequested: true,
      },
    ],
  });
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  for (const id of ["running", "uncertain"]) {
    assert.equal(byId[id].command, "queue.cancel");
    assert.match(byId[id].cancelNotice, /уже отправлено/);
    assert.match(byId[id].cancelNotice, /результат останется на проверке/);
  }
  assert.equal(byId.waiting.cancelNotice, null);
  assert.equal(byId["cancelled-request"].cancelNotice, null);
  assert.match(byId.uncertain.reconciliationNotice, /ещё не подтверждён/);
  assert.match(
    byId["cancelled-request"].reconciliationNotice,
    /ещё не подтверждён/,
  );
  assert.equal(byId.running.reconciliationNotice, null);
  assert.equal(byId.waiting.reconciliationNotice, null);
});

test("shows floor and character progress using authoritative actor state", () => {
  const cards = actionQueueCards({
    floorRunner: { status: "paused" },
    workFarm: { run: { status: "running" } },
    characterUpgrade: { run: { status: "running", completed: 2, target: 5 } },
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["floor", "character"],
  );
  assert.equal(cards[0].status, "Приостановлено");
  assert.deepEqual(cards[1].progress, { value: 2, max: 5 });
});

test("an uncertain character upgrade remains visible without promising cancellation", () => {
  const cards = actionQueueCards({
    characterUpgrade: {
      run: {
        id: "run-1",
        queueId: "upgrade-1",
        status: "uncertain",
        completed: 1,
        target: 2,
      },
      pending: { runId: "older-run" },
    },
    queuedActions: [
      {
        id: "upgrade-1",
        type: "character.start",
        status: "completed",
        priority: 20,
        createdAt: 1,
        args: {},
      },
    ],
  });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].status, "Проверяем результат");
  assert.equal(cards[0].command, null);
  assert.deepEqual(cards[0].progress, { value: 1, max: 2 });
});

test("Buddy remains separately stoppable while floor automation is active", () => {
  const cards = actionQueueCards({
    floorRunner: { status: "running" },
    buddy: { enabled: true, hasSuspendedGoal: true },
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["buddy", "floor"],
  );
  assert.equal(cards[0].command, "buddy.stop");
  assert.equal(cards[0].focusBuddy, true);
  assert.equal(cards[1].floorTarget, null);
});

test("active floor and subscription cards retain their destination context", () => {
  const cards = actionQueueCards({
    floorRunner: {
      status: "running",
      target: { kind: "business", destination: "C2", entityId: "shop" },
    },
    subscription: {
      enabled: true,
      leaderPlayerId: 42,
      leaderUsername: "leader",
      bossId: 7,
    },
  });
  assert.deepEqual(cards[0].raidTarget, {
    leaderPlayerId: 42,
    leaderUsername: "leader",
    bossId: 7,
  });
  assert.deepEqual(cards[1].floorTarget, {
    kind: "business",
    destination: "C2",
    entityId: "shop",
  });
});

test("a stopped Buddy remains visible until its suspended action is reconciled", () => {
  const cards = actionQueueCards({
    buddy: { enabled: false, hasSuspendedGoal: true },
  });
  assert.equal(cards[0].status, "Завершаем рейд");
  assert.equal(cards[0].command, null);
});

test("a stopped subscription stays visible while its raid finishes", () => {
  const cards = actionQueueCards({
    subscription: { enabled: false, hasSuspendedGoal: true },
  });
  assert.equal(cards[0].status, "Завершаем рейд");
  assert.equal(cards[0].command, null);
});

test("a raid interruption does not hide a suspended business goal", () => {
  const cards = actionQueueCards({
    buddy: { enabled: true, hasSuspendedGoal: true },
    raid: { enabled: true },
    businessAssistant: { run: { status: "running", name: "Мастерская" } },
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["buddy", "raid", "business"],
  );
  assert.equal(cards[2].status, "Ожидает рейд");
  assert.equal(cards[2].command, "business.run.stop");
  assert.equal(cards[1].command, "raid.stop");
  assert.equal(cards[0].command, "buddy.stop");
});

test("a suspended work goal remains independently stoppable", () => {
  const cards = actionQueueCards({
    subscription: { enabled: true, hasSuspendedGoal: true },
    workFarm: { run: { status: "running", workId: 7 } },
  });
  const card = cards.find((item) => item.id === "work");
  assert.equal(card.status, "Ожидает рейд");
  assert.equal(card.command, "work.stop");
  assert.equal(card.pauseCommand, undefined);
});

test("a suspended autobattle is distinct from the subscribed fight", () => {
  const cards = actionQueueCards({
    subscription: {
      enabled: true,
      hasSuspendedGoal: true,
      suspendedAuto: true,
    },
    auto: { enabled: true },
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["subscription", "auto"],
  );
  assert.equal(cards[1].status, "Ожидает рейд");
  assert.equal(cards[1].command, "auto.stop");
});

test("a standalone suspended goal remains visible and stoppable", () => {
  const cards = actionQueueCards({
    buddy: {
      enabled: true,
      hasSuspendedGoal: true,
      suspendedStandaloneGoal: true,
    },
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["buddy", "goal"],
  );
  assert.equal(cards[1].command, "goal.stop");
});

test("paused work exposes resume and stopped uncertain work stays visible", () => {
  const paused = actionQueueCards({
    workFarm: { run: { workId: 1, status: "paused" } },
  });
  assert.equal(paused[0].status, "На паузе");
  assert.equal(paused[0].pauseCommand, "work.resume");
  assert.equal(paused[0].command, "work.stop");
  const stopped = actionQueueCards({
    workFarm: {
      run: { workId: 1, status: "stopped", pending: { kind: "performing" } },
    },
  });
  assert.equal(stopped[0].status, "Проверяем результат");
  assert.equal(stopped[0].command, null);
});

test("work progress reflects the current run and does not guess an unresolved target", () => {
  const run = {
    workId: 1,
    status: "running",
    completedCycles: 2,
    targetCycles: 5,
    queuedCycles: null,
    phase: "queued",
    energySpent: 12,
    config: { mode: "wait" },
  };
  const view = {
    workId: 1,
    completedCycles: 2,
    tasks: [{ required: 2, progress: 1, energyCost: 10 }],
  };
  let card = actionQueueCards({ workFarm: { run, view } })[0];
  assert.deepEqual(card.progress, { value: 12, max: 62 });
  assert.equal(card.status, "Ожидает другие действия");
  run.queuedCycles = 3;
  card = actionQueueCards({ workFarm: { run, view } })[0];
  assert.equal(card.progress, null);
  run.queuedCycles = null;
  card = actionQueueCards({ workFarm: { run } })[0];
  assert.equal(card.progress, null);
  assert.equal(
    actionQueueCards({ workFarm: { run: { status: "running" } } })[0].progress,
    null,
  );
});

test("paused autobattle exposes resume while its goal remains visible", () => {
  const cards = actionQueueCards({
    auto: { enabled: false, userPaused: true },
    battle: { boss: { name: "Босс" } },
    goal: { progress: 2, target: 5 },
  });
  assert.equal(cards[0].title, "Босс");
  assert.equal(cards[0].status, "На паузе");
  assert.equal(cards[0].pauseCommand, "auto.resume");
  assert.deepEqual(cards[0].progress, { value: 2, max: 5 });
});

test("raid pause and resume controls reflect server-owned state", () => {
  const running = actionQueueCards({ raid: { enabled: true } });
  assert.equal(running[0].pauseCommand, "raid.pause");
  const paused = actionQueueCards({
    raid: { enabled: false, userPaused: true },
  });
  assert.equal(paused[0].status, "На паузе");
  assert.equal(paused[0].pauseCommand, "raid.resume");
});

test("business run exposes its pause and resume state", () => {
  const state = {
    businessAssistant: { run: { status: "running", name: "Мастерская" } },
  };
  assert.equal(actionQueueCards(state)[0].pauseCommand, "business.run.pause");
  state.businessAssistant.run.status = "paused";
  const card = actionQueueCards(state)[0];
  assert.equal(card.title, "Мастерская");
  assert.equal(card.status, "На паузе");
  assert.equal(card.pauseCommand, "business.run.resume");
});

test("a waiting battle goal can be stopped and a started business intention is not duplicated", () => {
  const state = {
    goal: { status: "active" },
    businessAssistant: { run: null },
    queuedActions: [
      {
        id: "business-run-1",
        type: "business.start",
        status: "queued",
        eligible: false,
        priority: 15,
        createdAt: 0,
        args: { businessId: "business:7" },
      },
    ],
  };
  const waiting = actionQueueCards(state);
  assert.equal(waiting[0].command, "goal.stop");
  assert.equal(waiting[1].status, "Ожидает другие действия");
  state.goal = null;
  state.businessAssistant.run = {
    status: "running",
    queueId: "business-run-1",
    name: "Мастерская",
  };
  assert.deepEqual(
    actionQueueCards(state).map((card) => card.id),
    ["business"],
  );
});

test("a queued booster identifies its type and explains a blocked execution", () => {
  const cards = actionQueueCards({
    serverTime: 100,
    queuedActions: [
      {
        id: "booster-job",
        type: "work.booster",
        status: "queued",
        eligible: false,
        priority: 30,
        createdAt: 0,
        args: { workId: 7, type: "small" },
      },
    ],
  });
  assert.equal(cards[0].title, "Дефибриллятор");
  assert.equal(cards[0].detail, "Малый");
  assert.equal(cards[0].status, "Ожидает другие действия");
  assert.equal(cards[0].position, null);
});

test("blocked jobs do not get a misleading ready position", () => {
  const job = {
    id: "job",
    type: "inventory",
    status: "queued",
    eligible: true,
    blockedBy: "action",
    priority: 30,
    createdAt: 0,
    args: { type: "weapon", id: 1, action: "buy" },
  };
  let card = actionQueueCards({ serverTime: 100, queuedActions: [job] })[0];
  assert.equal(card.status, "Ожидает другие действия");
  assert.equal(card.position, null);
  job.blockedBy = "game";
  card = actionQueueCards({ serverTime: 100, queuedActions: [job] })[0];
  assert.equal(card.status, "Ожидает игру");
  job.blockedBy = null;
  card = actionQueueCards({ serverTime: 100, queuedActions: [job] })[0];
  assert.equal(card.position, 1);
});

test("visible ordering places due reconciliation before ordinary actions", () => {
  const common = {
    type: "inventory",
    eligible: true,
    createdAt: 1000,
    args: { type: "weapon", id: 1, action: "buy" },
  };
  const cards = actionQueueCards({
    serverTime: 1000,
    queuedActions: [
      { ...common, id: "ordinary", status: "queued", priority: 30 },
      { ...common, id: "uncertain", status: "reconciling", priority: 15 },
    ],
  });
  assert.deepEqual(
    cards.map((card) => card.id),
    ["uncertain", "ordinary"],
  );
  assert.deepEqual(
    cards.map((card) => card.position),
    [1, 2],
  );
});

test("a queued floor start is replaced by its active runner card", () => {
  const job = {
    id: "floor-job",
    type: "floor.start",
    status: "queued",
    eligible: false,
    priority: 15,
    createdAt: 0,
    args: {},
  };
  const state = { queuedActions: [job], floorRunner: { status: "stopped" } };
  let cards = actionQueueCards(state);
  assert.equal(cards[0].title, "Открытие этажа");
  assert.equal(cards[0].status, "Ожидает другие действия");
  state.floorRunner = { status: "running", queueId: "floor-job" };
  cards = actionQueueCards(state);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].command, "floor.stop");
});

test("a queued work goal is named and replaced by its running actor", () => {
  const job = {
    id: "work-job",
    type: "work.start",
    status: "queued",
    eligible: false,
    priority: 20,
    createdAt: 0,
    args: { workId: 7 },
  };
  const state = { queuedActions: [job], workFarm: { run: null } };
  const catalogue = { works: [{ workId: 7, name: "Работа" }] };
  let cards = actionQueueCards(state, catalogue);
  assert.equal(cards[0].title, "Работа");
  assert.equal(cards[0].status, "Ожидает другие действия");
  state.workFarm.run = { status: "running", queueId: "work-job", workId: 7 };
  cards = actionQueueCards(state, catalogue);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].command, "work.stop");
});

test("a queued character upgrade identifies its target and is not duplicated after start", () => {
  const job = {
    id: "character-job",
    type: "character.start",
    status: "queued",
    eligible: false,
    priority: 20,
    createdAt: 0,
    args: { quotes: [{ stat: "madness" }] },
  };
  const state = { queuedActions: [job], characterUpgrade: { run: null } };
  let cards = actionQueueCards(state);
  assert.equal(cards[0].title, "Прокачка характеристик");
  assert.equal(cards[0].detail, "Безумие");
  assert.equal(cards[0].status, "Ожидает другие действия");
  state.characterUpgrade.run = { status: "running", queueId: "character-job" };
  cards = actionQueueCards(state);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].command, "character.stop");
});

test("subscription waiting for identity confirmation has a clear queue status", () => {
  const cards = actionQueueCards({
    queuedActions: [
      {
        id: "sub-01",
        type: "subscription.start",
        status: "waiting",
        reason: "Ожидаем приглашение.",
        priority: 15,
        createdAt: 0,
        args: { leaderUsername: "leader" },
      },
    ],
  });
  assert.equal(cards[0].title, "Подписка на рейды");
  assert.equal(cards[0].status, "Ожидает приглашение");
  assert.equal(cards[0].detail, "@leader");
  assert.deepEqual(cards[0].raidTarget, {
    leaderPlayerId: null,
    leaderUsername: "leader",
    bossId: null,
  });
});

test("friend and Buddy queue cards preserve the account target for navigation", () => {
  const cards = actionQueueCards({
    queuedActions: [
      {
        id: "buddy-01",
        type: "friend.buddy",
        status: "queued",
        priority: 1,
        createdAt: 0,
        args: { playerId: 42, name: "Игрок" },
      },
      {
        id: "request-01",
        type: "friend.request",
        status: "queued",
        priority: 1,
        createdAt: 1,
        args: { playerId: 7, username: "leader" },
      },
    ],
  });
  assert.deepEqual(cards[0].friendTarget, { playerId: 42 });
  assert.deepEqual(cards[1].raidTarget, {
    leaderPlayerId: 7,
    leaderUsername: "leader",
    bossId: null,
  });
});
