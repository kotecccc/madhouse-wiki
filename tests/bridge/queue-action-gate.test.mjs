import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createWorkActionPermit } from "../../scripts/bridge/work-action-permit.mjs";
import { createActionQueue } from "../../scripts/automation/action-queue.mjs";
import { createAccountQueue } from "../../scripts/automation/account-queue.mjs";
import { queuedFriendResponseAdapter } from "../../scripts/automation/queued-friend-response.mjs";

test("waiting account lane preserves the work dispatch permission", async () => {
  const gate = createQueueActionGate();
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const request = {
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
  const permit = createWorkActionPermit({
    authorization: request.authorization,
    workId: 7,
    taskId: 2,
    operationId: "op",
    checkpointIsCurrent: () => true,
  });
  const queue = createAccountQueue(
    async (url) => {
      if (url.endsWith("/hold")) await blocked;
      else assert.equal(gate.claim(request), true);
      return new Response("{}");
    },
    { captureDispatchContext: gate.capture },
  );
  const held = queue("https://cargohustle.online/hold", {
    headers: { Authorization: request.authorization },
  });
  const work = gate.runWork(permit, () =>
    queue("https://cargohustle.online/api/works/tasks/perform", {
      method: "POST",
      headers: { Authorization: request.authorization },
      body: request.body,
    }),
  );
  release();
  await Promise.all([held, work]);
  assert.equal(gate.claim(request), false);
});

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

test("friend removal permission is bound to the queued friend and cannot be replayed", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "remove-42",
    status: "running",
    type: "friend.remove",
    args: { playerId: 42 },
  };
  const request = {
    authorization: "Bearer fake",
    method: "DELETE",
    path: "/api/friends/42",
  };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(gate.claim({ ...request, path: "/api/friends/43" }), false);
      assert.equal(gate.claim({ ...request, method: "POST" }), false);
      assert.equal(gate.claim(request), true);
      assert.equal(gate.claim(request), false);
    },
    () => true,
  );
  await gate.run(
    job,
    true,
    request.authorization,
    async () => {
      assert.equal(gate.claim(request), false);
    },
    () => true,
  );
});

test("friend request requires the matching persisted recipient and allows one send", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "request-42",
    type: "friend.request",
    status: "running",
    args: { playerId: null, username: "friend" },
  };
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/friends/requests",
    body: JSON.stringify({ playerId: 42 }),
  };
  let pending = { id: job.id, playerId: 43 };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(gate.claim(request), false);
      pending = { id: job.id, playerId: 42 };
      assert.equal(
        gate.claim({
          ...request,
          body: JSON.stringify({ playerId: 42, extra: true }),
        }),
        false,
      );
      assert.equal(gate.claim(request), true);
      assert.equal(gate.claim(request), false);
    },
    () => true,
    () => pending,
  );
  await gate.run(
    job,
    true,
    request.authorization,
    async () => assert.equal(gate.claim(request), false),
    () => true,
    () => pending,
  );
});

test("booster purchase and use require their exact durable checkpoint", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "booster",
    status: "running",
    type: "energy.booster",
    args: { type: "small" },
  };
  let pending = {
    id: job.id,
    type: "small",
    phase: "buying",
    operationId: "op",
  };
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/me/bag/boosters/buy",
    body: JSON.stringify({ type: "small", quantity: 1, operationId: "op" }),
  };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(
        gate.claim({
          ...request,
          body: JSON.stringify({
            type: "small",
            quantity: 2,
            operationId: "op",
          }),
        }),
        false,
      );
      assert.equal(gate.claim(request), true);
      assert.equal(gate.claim(request), false);
    },
    () => true,
    () => pending,
  );
  pending = { id: job.id, type: "small", phase: "using" };
  const use = {
    ...request,
    path: "/api/me/bag/boosters/use",
    body: JSON.stringify({ type: "small" }),
  };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(gate.claim(request), false);
      assert.equal(gate.claim(use), true);
    },
    () => true,
    () => pending,
  );
});

test("inventory action must match the saved item and operation", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "inventory",
    type: "inventory",
    status: "running",
    args: { type: "weapon", id: 7, action: "buy" },
  };
  const pending = {
    id: job.id,
    type: "weapon",
    entityId: 7,
    action: "buy",
    zoneId: null,
    operationId: "op",
  };
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/weapons/buy",
    body: JSON.stringify({ weaponId: 7, operationId: "op" }),
  };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(
        gate.claim({
          ...request,
          body: JSON.stringify({ weaponId: 8, operationId: "op" }),
        }),
        false,
      );
      assert.equal(gate.claim(request), true);
      assert.equal(gate.claim(request), false);
    },
    () => true,
    () => pending,
  );
});

test("battle start and attack bind the persisted operation to the right battle", async () => {
  const gate = createQueueActionGate();
  const job = {
    id: "attack",
    type: "battle.attack",
    status: "running",
    args: { bossId: 7, battleId: "battle-1" },
  };
  const pending = {
    id: job.id,
    kind: "attack",
    bossId: 7,
    battleId: "battle-1",
    operationId: "op",
  };
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/bosses/battles/battle-1/attack",
    body: JSON.stringify({ operationId: "op" }),
  };
  await gate.run(
    job,
    false,
    request.authorization,
    async () => {
      assert.equal(
        gate.claim({ ...request, path: "/api/bosses/battles/battle-2/attack" }),
        false,
      );
      assert.equal(gate.claim(request), true);
      assert.equal(gate.claim(request), false);
    },
    () => true,
    () => pending,
  );
});
