import test from "node:test";
import assert from "node:assert/strict";
import { stashCraftCompleted } from "../src/features/action-queue/stash-craft-refresh.js";

test("refresh after a newly completed craft, including a fast job", () => {
  const job = { type: "stash.craft", status: "completed" };
  assert.equal(stashCraftCompleted(job, "running", true), true);
  assert.equal(stashCraftCompleted(job, undefined, true), true);
  assert.equal(stashCraftCompleted(job, undefined, false), false);
  assert.equal(stashCraftCompleted(job, "completed", true), false);
  assert.equal(
    stashCraftCompleted({ ...job, status: "failed" }, "running", true),
    false,
  );
});
