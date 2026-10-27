import test from "node:test";
import assert from "node:assert/strict";
import { actionQueueCards } from "../src/features/action-queue/action-queue-view.js";

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
  assert.equal(battle.detail, "Босс");
  assert.equal(battle.image, "/boss.png");
});
