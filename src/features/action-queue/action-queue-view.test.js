import { test } from "node:test";
import assert from "node:assert/strict";
import { actionQueueCards } from "./action-queue-view.js";

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

test("work progress uses confirmed cycles and does not guess an unresolved target", () => {
  const run = {
    workId: 1,
    status: "running",
    completedCycles: 2,
    targetCycles: 5,
    queuedCycles: null,
    phase: "queued",
  };
  let card = actionQueueCards({ workFarm: { run } })[0];
  assert.deepEqual(card.progress, { value: 2, max: 5 });
  assert.equal(card.status, "Ожидает другие действия");
  run.queuedCycles = 3;
  card = actionQueueCards({ workFarm: { run } })[0];
  assert.equal(card.progress, null);
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
});
