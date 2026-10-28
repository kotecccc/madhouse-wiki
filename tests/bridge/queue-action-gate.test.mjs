import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createWorkActionPermit } from "../../scripts/bridge/work-action-permit.mjs";
import { createActionQueue } from "../../scripts/automation/action-queue.mjs";
import { createAccountQueue } from "../../scripts/automation/account-queue.mjs";
import { queuedFriendResponseAdapter } from "../../scripts/automation/queued-friend-response.mjs";

test("work permission is scoped to its active context and consumed once", async () => {
  const gate = createQueueActionGate();
  const permit = createWorkActionPermit({
    authorization: "Bearer fake",
    workId: 7,
    taskId: 2,
    operationId: "op",
    checkpointIsCurrent: () => true,
  });
  const req = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/works/tasks/perform",
    body: JSON.stringify({
      workId: 7,
      taskId: 2,
      locale: "ru",
      operationId: "op",
    }),
  };
  assert.equal(gate.claim(req), false);
  await gate.runWork(permit, async () => {
    assert.equal(gate.claim({ ...req, path: "/api/other" }), false);
    assert.equal(gate.claim(req), true);
    assert.equal(gate.claim(req), false);
  });
  assert.equal(gate.claim(req), false);
});

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
  await gate.run(
    job,
    false,
    "Bearer fake",
    async () => {
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
    },
    () => true,
  );
  assert.equal(gate.claim(request), false);
  await gate.run(
    job,
    true,
    "Bearer fake",
    async () => assert.equal(gate.claim(request), false),
    () => true,
  );
  await gate.run(
    job,
    false,
    "Bearer fake",
    async () => {
      assert.equal(gate.claim(request), false);
    },
    () => false,
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
  await gate.run(
    job,
    false,
    "Bearer fake",
    async () => {
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
    },
    () => true,
  );
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
      runInContext: (job, reconcile, run, _reservation, canDispatch) =>
        gate.run(job, reconcile, "Bearer fake", run, canDispatch),
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

test("account serialization preserves only the waiting attempt's permission", async () => {
  const gate = createQueueActionGate();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const authorization = "Bearer fake";
  const target = "https://cargohustle.online/api/friends/requests/42/accept";
  const queue = createAccountQueue(
    async (url, init) => {
      if (url.endsWith("/api/me")) {
        await pending;
        return new Response("{}");
      }
      assert.equal(
        gate.claim({
          authorization,
          method: init.method,
          path: new URL(url).pathname,
        }),
        true,
      );
      return new Response("{}");
    },
    { captureDispatchContext: gate.capture },
  );
  const first = queue("https://cargohustle.online/api/me", {
    headers: { Authorization: authorization },
  });
  const job = {
    id: "test-job-1",
    status: "running",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  };
  const second = gate.run(
    job,
    false,
    authorization,
    () =>
      queue(target, {
        method: "POST",
        headers: { Authorization: authorization },
      }),
    () => true,
  );
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test("a lost friend response is reconciled without a second send", async () => {
  const gate = createQueueActionGate();
  const authorization = "Bearer fake";
  const entry = { credential: authorization };
  let now = 1;
  let saved = [];
  let accepted = false;
  let sends = 0;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === "POST") {
      assert.equal(
        gate.claim({ authorization, method: init.method, path }),
        true,
      );
      sends++;
      accepted = true;
      throw new Error("lost response");
    }
    const items =
      (path === "/api/friends" && accepted) ||
      (path === "/api/friends/requests/incoming" && !accepted)
        ? [{ player: { playerId: 42 } }]
        : [];
    return Response.json({ items, nextCursor: null });
  };
  const adapter = queuedFriendResponseAdapter({
    entry,
    fetcher,
    save: () => {},
  });
  const queue = createActionQueue({
    adapters: { "friend.response": adapter },
    persist: (value) => {
      saved = value;
    },
    now: () => now,
    runInContext: (job, reconcile, run, _reservation, canDispatch) =>
      gate.run(job, reconcile, authorization, run, canDispatch),
  });
  queue.add({
    id: "test-job-1",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  });
  await queue.tick();
  now += 60000;
  await queue.tick();
  assert.equal(sends, 1);
  assert.equal(saved[0].status, "completed");
});
