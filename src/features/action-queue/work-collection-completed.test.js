import test from "node:test";
import assert from "node:assert/strict";
import { workCollectionCompleted } from "./work-collection-completed.js";

test("notifies only when the observed collection run completes", () => {
  const previous = {
    status: "running",
    collectStash: true,
    workId: 7,
    startedAt: 10,
    queueId: "job",
  };
  const current = {
    status: "completed",
    config: { collectStash: true },
    workId: 7,
    startedAt: 10,
    queueId: "job",
  };
  assert.equal(workCollectionCompleted(previous, current), true);
  assert.equal(workCollectionCompleted(null, current), false);
  assert.equal(
    workCollectionCompleted(previous, { ...current, status: "limited" }),
    false,
  );
  assert.equal(
    workCollectionCompleted(previous, { ...current, status: "stopped" }),
    false,
  );
  assert.equal(
    workCollectionCompleted(previous, { ...current, startedAt: 11 }),
    false,
  );
  assert.equal(
    workCollectionCompleted({ ...previous, status: "completed" }, current),
    false,
  );
});
