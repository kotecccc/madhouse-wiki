import test from "node:test";
import assert from "node:assert/strict";
import { actionQueueCards } from "../src/features/action-queue/action-queue-view.js";

test("a finishing raid offers resume instead of another stop", () => {
  const [card] = actionQueueCards({
    raid: { enabled: true, stopAfterBattle: true, bossId: 7 },
  });
  assert.equal(card.status, "Завершает бой");
  assert.equal(card.pauseCommand, "raid.resume");
  assert.equal(card.command, null);
});

test("a finishing autobattle offers resume instead of another stop", () => {
  const [card] = actionQueueCards({
    auto: { enabled: true, stopAfterBattle: true },
    battle: { boss: { id: 7 } },
  });
  assert.equal(card.status, "Завершает бой");
  assert.equal(card.pauseCommand, "auto.resume");
  assert.equal(card.command, null);
});

test("battle series titles include the boss department when known", () => {
  const catalogue = {
    bosses: [
      { id: "boss-7", numericId: 7, name: "Босс", departmentId: "dept" },
    ],
    departments: [{ id: "dept", code: "J2" }],
  };
  const cards = actionQueueCards(
    {
      raid: { enabled: true, bossId: 7 },
      queuedActions: [
        {
          id: "next",
          type: "auto.start",
          status: "queued",
          args: { bossId: 7 },
        },
      ],
    },
    catalogue,
  );
  assert.deepEqual(
    cards.map((card) => card.title),
    ["J2 • Босс", "J2 • Босс"],
  );
});

test("queue cards retain the target for work, business and boss navigation", () => {
  const work = { apiId: 7, title: "Архив", image: "/work.png" };
  const boss = { id: "boss:8", numericId: 8, name: "Босс", image: "/boss.png" };
  const cards = actionQueueCards(
    {
      serverTime: 100,
      businessAssistant: {
        run: { status: "running", businessId: "business:2" },
      },
      workFarm: { run: { status: "running", workId: 7 } },
      queuedActions: [
        {
          id: "battle",
          type: "auto.start",
          args: { settings: { bossId: 8 } },
          status: "queued",
          priority: 1,
          createdAt: 0,
        },
      ],
    },
    { works: [work], bosses: [boss] },
  );
  assert.equal(cards.find((card) => card.id === "work").work, work);
  assert.equal(
    cards.find((card) => card.id === "business").businessId,
    "business:2",
  );
  const battle = cards.find((card) => card.id === "battle");
  assert.equal(battle.bossId, 8);
  assert.equal(battle.title, "Босс");
  assert.equal(battle.detail, "Автобой");
  assert.equal(battle.image, "/boss.png");
});

test("raid queue shows each actual boss and omits completed battle handoff history", () => {
  const bosses = [
    { numericId: 58, name: "Белорогая", image: "/58.png" },
    { numericId: 13, name: "Мать Авелина", image: "/13.png" },
  ];
  const state = {
    raid: { enabled: true, bossId: 58, queueId: "raid-current" },
    battle: { boss: { id: 58, name: "Белорогая" } },
    queuedActions: [
      ...[1, 2, 3].map((i) => ({
        id: `old-${i}`,
        type: "auto.start",
        args: { settings: { bossId: 19 } },
        status: "completed",
        createdAt: i,
      })),
      {
        id: "raid-current",
        type: "raid.start",
        args: { settings: { bossId: 58, kind: "battles", targetCount: 7 } },
        status: "completed",
        createdAt: 4,
      },
      {
        id: "raid-next",
        type: "raid.start",
        args: { settings: { bossId: 13 } },
        status: "waiting",
        createdAt: 5,
      },
    ],
  };
  const cards = actionQueueCards(state, { bosses });
  assert.deepEqual(
    cards.map((card) => [card.title, card.detail, card.bossId]),
    [
      ["Белорогая", "Рейд", 58],
      ["Мать Авелина", "Рейд", 13],
    ],
  );
  assert.equal(cards[0].command, "raid.stop");
  assert.equal(cards[0].series.settings.targetCount, 7);
  assert.equal(cards[0].series.goal, null);
  assert.equal(cards[1].command, "queue.cancel");
});
