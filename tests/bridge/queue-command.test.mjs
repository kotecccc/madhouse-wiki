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
  const original = request(allowed);
  assert.equal(await isAllowedBridgeQueueCommand(original), true);
  assert.deepEqual(await original.json(), allowed);
  for (const input of [
    { command: "friends.respond", args: { playerId: 42 } },
    { command: "queue.enqueue", args: { type: "battle.attack" } },
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
