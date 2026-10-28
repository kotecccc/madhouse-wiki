import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hasNewCharacterUpgradeProgress } from "./character-upgrade-progress.js";

test("refreshes only when a character upgrade has confirmed new steps", () => {
  assert.equal(
    hasNewCharacterUpgradeProgress(null, { id: "run", completed: 0 }),
    false,
  );
  assert.equal(
    hasNewCharacterUpgradeProgress(null, { id: "run", completed: 1 }),
    true,
  );
  assert.equal(
    hasNewCharacterUpgradeProgress(
      { id: "run", completed: 1 },
      { id: "run", completed: 2 },
    ),
    true,
  );
  assert.equal(
    hasNewCharacterUpgradeProgress(
      { id: "run", completed: 1 },
      { id: "run", completed: 1, status: "completed" },
    ),
    false,
  );
  assert.equal(
    hasNewCharacterUpgradeProgress(
      { id: "run", completed: 1 },
      { id: "new", completed: 0 },
    ),
    false,
  );
  assert.equal(
    hasNewCharacterUpgradeProgress(null, { id: "run", completed: null }),
    false,
  );
});
