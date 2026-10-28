import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeRestorePolicy } from "../shared/bridge-restore-policy.js";

test("legacy restore waits for bridge status and fails closed for existing or unavailable bridge", () => {
  assert.equal(bridgeRestorePolicy(false, "pending"), "allow");
  assert.equal(bridgeRestorePolicy(true, "pending"), "wait");
  assert.equal(bridgeRestorePolicy(true, "not_configured"), "allow");
  assert.equal(bridgeRestorePolicy(true, "saved"), "skip");
  assert.equal(bridgeRestorePolicy(true, "unavailable"), "skip");
});
