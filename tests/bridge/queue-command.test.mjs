import assert from "node:assert/strict";
import { test } from "node:test";
import { isAllowedBridgeQueueCommand } from "../../scripts/bridge/queue-command.mjs";

const request = (body, path = "/api/automation/commands") =>
  new Request(`https://wiki.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("only the supported durable queue command is admitted", async () => {
  const allowed = {
    command: "queue.enqueue",
    args: {
      type: "friend.response",
      action: { playerId: 42, decision: "accept" },
    },
  };
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({
        command: "queue.enqueue",
        args: { type: "friend.remove", action: { playerId: 42 } },
      }),
    ),
    true,
  );
  for (const input of [
    { command: "buddy.set", args: { playerId: 42, enabled: true } },
    { command: "friends.favorite", args: { playerId: 42, enabled: false } },
    { command: "buddy.order", args: { friendIds: [42, 43] } },
    {
      command: "queue.enqueue",
      args: {
        type: "friend.favorite",
        action: { playerId: 42, enabled: true },
      },
    },
    {
      command: "queue.enqueue",
      args: { type: "friend.buddy", action: { playerId: 42, enabled: true } },
    },
  ])
    assert.equal(await isAllowedBridgeQueueCommand(request(input)), true);
  const original = request(allowed);
  assert.equal(await isAllowedBridgeQueueCommand(original), true);
  assert.deepEqual(await original.json(), allowed);
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({ command: "work.refresh", args: { workId: 7 } }),
    ),
    true,
  );
  assert.equal(
    await isAllowedBridgeQueueCommand(request({ command: "work.stop" })),
    true,
  );
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({ command: "work.plan", args: { workId: 7 } }),
    ),
    true,
  );
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({
        command: "queue.enqueue",
        args: { type: "work.start", action: { mode: "energy" } },
      }),
    ),
    true,
  );
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({ command: "queue.cancel", args: { id: "test-job-1" } }),
    ),
    true,
  );
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request({ command: "queue.dismiss", args: { id: "test-job-1" } }),
    ),
    true,
  );
  for (const input of [
    { command: "buddy.set", args: { playerId: 0, enabled: true } },
    { command: "buddy.order", args: { friendIds: [0] } },
    { command: "friends.favorite", args: { playerId: 42, enabled: "yes" } },
    { command: "friends.respond", args: { playerId: 42 } },
    { command: "work.start", args: { mode: "energy" } },
    { command: "work.refresh", args: { workId: -1 } },
    { command: "work.plan", args: { workId: 0 } },
    { command: "queue.enqueue", args: { type: "battle.other" } },
    {},
    "bad-json",
    "x".repeat(16385),
  ])
    assert.equal(await isAllowedBridgeQueueCommand(request(input)), false);
  assert.equal(
    await isAllowedBridgeQueueCommand(
      request(allowed, "/api/automation/commands?extra=1"),
    ),
    false,
  );
});
