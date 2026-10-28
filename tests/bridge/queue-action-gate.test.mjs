import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createActionQueue } from "../../scripts/automation/action-queue.mjs";

test("only the matching queued attempt receives one permission", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "test",
    status: "running",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  };
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/friends/requests/42/accept",
  };
  assert.equal(gate.claim(request), false);
  await gate.run(job, false, "Bearer fake", async () => {
    assert.equal(
      gate.claim({ ...request, authorization: "Bearer other" }),
      false,
    );
    assert.equal(
      gate.claim({ ...request, path: "/api/friends/requests/43/accept" }),
      false,
    );
    assert.equal(gate.claim(request), true);
    assert.equal(gate.claim(request), false);
  });
  assert.equal(gate.claim(request), false);
  await gate.run(job, true, "Bearer fake", async () =>
    assert.equal(gate.claim(request), false),
  );
});

test("permission expires for asynchronous work after an attempt ends", async () => {
  const gate = createQueueActionGate();
  let later;
  const job = {
    id: "test",
    status: "running",
    type: "friend.response",
    args: { playerId: 42, decision: "decline" },
  };
  await gate.run(job, false, "Bearer fake", async () => {
    later = new Promise((resolve) =>
      setTimeout(
        () =>
          resolve(
            gate.claim({
              authorization: "Bearer fake",
              method: "DELETE",
              path: "/api/friends/requests/42",
            }),
          ),
        10,
      ),
    );
  });
  assert.equal(await later, false);
});

test("a persisted queue attempt grants once, while restart reconciliation grants nothing", async () => {
  const gate = createQueueActionGate();
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/friends/requests/42/accept",
  };
  let saved = [];
  let sawPersistedRunning = false;
  const adapter = {
    validate: (args) => args,
    execute: async () => {
      sawPersistedRunning = saved[0].status === "running";
      assert.equal(gate.claim(request), true);
      return { status: "uncertain" };
    },
    reconcile: async () => {
      assert.equal(gate.claim(request), false);
      return { status: "uncertain" };
    },
  };
  const build = (previous = []) =>
    createActionQueue({
      saved: previous,
      adapters: { "friend.response": adapter },
      persist: (value) => {
        saved = value;
      },
      now: () => 100,
      runInContext: (job, reconcile, run) =>
        gate.run(job, reconcile, "Bearer fake", run),
    });
  const queue = build();
  queue.add({
    id: "test-job-1",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  });
  await queue.tick();
  assert.equal(sawPersistedRunning, true);
  assert.equal(saved[0].status, "reconciling");
  saved[0].status = "running";
  const restarted = build(saved);
  await restarted.tick();
  assert.equal(saved[0].status, "reconciling");
});
