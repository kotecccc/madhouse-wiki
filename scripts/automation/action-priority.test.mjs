import test from "node:test";
import assert from "node:assert/strict";
import { actionPriority } from "./action-priority.mjs";
import { actionQueuePriority } from "../../src/lib/action-queue-priority.js";

test("manual combat and equipment take priority over ordinary and automated work", () => {
  const attack = actionPriority("battle.attack");
  const equip = actionPriority("inventory", {
    type: "weapon",
    action: "equip",
  });
  assert.equal(attack, equip);
  assert.ok(attack > actionPriority("invitation.accept"));
  assert.ok(
    actionPriority("invitation.accept") > actionPriority("friend.request"),
  );
  assert.equal(actionPriority("friend.request"), actionPriority("work.start"));
  assert.ok(actionPriority("work.start") > actionPriority("auto.start"));
  assert.equal(
    actionPriority("inventory", {
      type: "weapon",
      action: "buy",
      priority: 999,
    }),
    30,
  );
});

test("an expiring invitation is selected before a fresh manual action while reconciliation stays urgent", () => {
  const now = 1_000_000;
  const invitation = {
    type: "invitation.accept",
    args: { expiresAt: now + 30_000 },
    priority: 45,
    status: "queued",
    createdAt: now,
  };
  const manual = {
    type: "battle.attack",
    priority: 50,
    status: "queued",
    createdAt: now,
  };
  const recovery = { ...manual, status: "reconciling" };
  assert.ok(
    actionQueuePriority(invitation, now) > actionQueuePriority(manual, now),
  );
  assert.ok(
    actionQueuePriority(recovery, now) > actionQueuePriority(invitation, now),
  );
});
