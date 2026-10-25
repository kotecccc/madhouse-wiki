import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkStash } from "../shared/work-stash.js";
import { createWorkFarm } from "../scripts/automation/work-farm.mjs";
import { isSnapshotPath } from "../scripts/account/snapshots.mjs";

test("stash quantity, discovery and purchase unlock are independent", () => {
  const value = normalizeWorkStash(
    {
      sets: [
        {
          setId: 3,
          ingredients: [
            { ingredientId: 1, owned: 0, purchaseUnlocked: true },
            { ingredientId: 2, owned: 7, purchaseUnlocked: false },
            { ingredientId: 3, owned: false },
            { ingredientId: 4, owned: -1 },
          ],
        },
      ],
    },
    3,
  );
  assert.deepEqual(
    value.ingredients.map((item) => item.quantity),
    [0, 7, null, null],
  );
  assert.ok(value.ingredients.every((item) => item.unlocked === null));
  assert.equal(value.ingredients[0].purchaseUnlocked, true);
  assert.equal(value.ingredients[1].purchaseUnlocked, false);
  assert.equal(normalizeWorkStash({ sets: [] }, 3, value), value);
  assert.equal(isSnapshotPath("/api/stash/sets"), true);
});

test("optional bulk stash failure preserves work calculator and confirmed inventory", async () => {
  let fail = false,
    reads = 0;
  const farm = createWorkFarm({
    getWork: () => ({ workId: 7, stashSetId: 3 }),
    getStash: async () => {
      reads++;
      if (fail) throw new Error("offline");
      return {
        sets: [{ setId: 3, ingredients: [{ ingredientId: 1, owned: 2 }] }],
      };
    },
    request: async (_method, path) => {
      if (path === "/api/works/open")
        return {
          workId: 7,
          title: "Test work",
          completedCycles: 0,
          tasks: [
            {
              id: 1,
              required: 1,
              progress: 0,
              energyCost: 1,
              canPerform: true,
            },
          ],
        };
      if (path === "/api/me")
        return { energy: { current: 10, max: 10 }, wallet: { dollar: 0 } };
      return {};
    },
  });
  await farm.refresh(7);
  assert.equal(farm.getSnapshot().view.stash.ingredients[0].quantity, 2);
  fail = true;
  await farm.refresh(7);
  assert.equal(farm.getSnapshot().view.stash.ingredients[0].quantity, 2);
  assert.equal(farm.getSnapshot().view.energy.current, 10);
  assert.equal(farm.getSnapshot().notice, null);
  assert.equal(reads, 2);
  farm.dispose();
});

test("work health scopes optional failures without accepting unknown/global failures", async () => {
  const { workGameUnavailable } =
    await import("../shared/game-health-features.js");
  assert.equal(
    workGameUnavailable({
      status: "unavailable",
      failedFeatures: ["ornaments", "weapons"],
    }),
    false,
  );
  for (const failedFeatures of [
    [],
    ["game"],
    ["profile"],
    ["inventory"],
    ["ornaments", "inventory"],
  ]) {
    assert.equal(
      workGameUnavailable({ status: "unavailable", failedFeatures }),
      true,
    );
  }
  assert.equal(
    workGameUnavailable({
      status: "credentials_invalid",
      failedFeatures: ["ornaments"],
    }),
    true,
  );
});
