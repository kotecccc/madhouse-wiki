import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";

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
