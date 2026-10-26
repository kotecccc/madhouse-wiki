import test from "node:test";
import assert from "node:assert/strict";
import { createRaidPriority } from "../scripts/automation/raid-priority.mjs";

function harness() {
  const state = { boss: { id: 7 }, battle: null };
  const calls = [];
  const objects = {
    controller: { getSnapshot: () => state },
    goal: {
      getSnapshot: () => ({ status: "active" }),
      exportState: () => ({ settings: { bossId: 7 }, attempts: ["one"] }),
      reset: () => calls.push("goal.reset"),
    },
    auto: {
      exportState: () => ({ enabled: true }),
      stop: () => calls.push("auto.stop"),
    },
    raid: {
      getSnapshot: () => ({ enabled: true }),
      canSuspend: () => true,
      suspend: () => {
        calls.push("raid.suspend");
        return true;
      },
    },
    work: {
      running: () => true,
      canSuspend: () => true,
      suspend: () => {
        calls.push("work.suspend");
        return true;
      },
    },
    business: {
      running: () => true,
      canSuspend: () => true,
      suspend: () => {
        calls.push("business.suspend");
        return true;
      },
    },
  };
  return { state, calls, objects, priority: createRaidPriority(objects) };
}

test("captures the goal and worker intentions before suspending them", () => {
  const h = harness();
  const checkpoint = h.priority.capture();
  assert.deepEqual(checkpoint.goal.attempts, ["one"]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.priority.suspend(checkpoint), true);
  assert.deepEqual(h.calls, [
    "raid.suspend",
    "business.suspend",
    "work.suspend",
    "auto.stop",
    "goal.reset",
  ]);
});

test("an active fight or uncertain action prevents all suspension effects", () => {
  const h = harness();
  h.state.battle = { status: "active" };
  assert.equal(h.priority.capture(), null);
  h.state.battle = null;
  h.state.pendingInvitation = { invitationId: "uncertain" };
  assert.equal(h.priority.capture(), null);
  assert.equal(h.priority.suspend({ raidEnabled: true }), false);
  assert.deepEqual(h.calls, []);
});

test("rechecks eligibility before suspension if a worker began an action", () => {
  const h = harness();
  const checkpoint = h.priority.capture();
  h.objects.work.canSuspend = () => false;
  assert.equal(h.priority.suspend(checkpoint), false);
  assert.deepEqual(h.calls, []);
});
