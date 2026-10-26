import assert from "node:assert/strict";
import test from "node:test";
import {
  newlyConfirmedFeatures,
  pruneDismissedFeatures,
} from "../src/components/layout/BottomDock/toast-dismissal.js";

test("dismissal stays per feature and clears only after that feature recovers", () => {
  const dismissed = ["inventory"];
  const confirmed = ["inventory", "bosses"];

  assert.deepEqual(newlyConfirmedFeatures(dismissed, confirmed), ["bosses"]);
  const afterInventoryRecovers = pruneDismissedFeatures(dismissed, ["bosses"]);
  assert.deepEqual(afterInventoryRecovers, []);
  assert.deepEqual(
    newlyConfirmedFeatures(afterInventoryRecovers, ["inventory", "bosses"]),
    ["inventory", "bosses"],
  );
});
