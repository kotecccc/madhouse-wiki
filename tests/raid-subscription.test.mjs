import test from "node:test";
import assert from "node:assert/strict";
import { createRaidSubscription } from "../scripts/automation/raid-subscription.mjs";

function harness(saved) {
  let time = 1_000_000;
  let stored = saved;
  let battleStatus = "finished";
  let joinResult = "success";
  let reconciliation = "unknown";
  let priority = false;
  const calls = [];
  const worker = createRaidSubscription({
    saved,
    now: () => time,
    persist: (value) => {
      stored = structuredClone(value);
    },
    lock: () => true,
    unlock: () => {},
    priorityActive: () => priority,
    capture: () => ({ priorGoal: "saved" }),
    suspend: () => {
      calls.push(["suspend", stored.phase]);
      return true;
    },
    join: async (invitation) => {
      calls.push(["join", invitation.invitationId, stored.phase]);
      if (joinResult === "lost") throw new Error("lost reply");
      battleStatus = "active";
    },
    reconcile: async () => reconciliation,
    battle: () => battleStatus,
    fight: async () => {
      calls.push(["fight"]);
    },
    restore: async (checkpoint) => {
      calls.push(["restore", checkpoint.priorGoal, stored.phase]);
      return true;
    },
  });
  return {
    worker,
    calls,
    getSaved: () => structuredClone(stored),
    setTime: (at) => {
      time = at;
    },
    setBattle: (status) => {
      battleStatus = status;
    },
    setJoin: (result) => {
      joinResult = result;
    },
    setReconciliation: (result) => {
      reconciliation = result;
    },
    setPriority: (active) => {
      priority = active;
    },
    invitation: (overrides = {}) => ({
      leaderPlayerId: 42,
      bossId: 7,
      invitationId: "invite-a",
      battleId: "battle-a",
      available: true,
      expiresAt: time + 60_000,
      ...overrides,
    }),
  };
}

test("priority reconciles a lost join without joining or fighting until it ends", async () => {
  const h = harness();
  h.worker.start({ leaderPlayerId: 42, bossId: 7 });
  h.setJoin("lost");
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  h.setPriority(true);
  h.setReconciliation("joined");
  h.setBattle("active");
  await h.worker.tick();
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "fighting");
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ["suspend", "join"],
  );
  h.setPriority(false);
  await h.worker.tick();
  assert.equal(h.calls.at(-1)[0], "fight");
});

test("saves the suspended goal before joining only the selected leader and boss", async () => {
  const h = harness();
  assert.equal(h.worker.start({ leaderPlayerId: 42, bossId: 7 }), true);
  h.worker.observe([h.invitation({ leaderPlayerId: 43 })], true);
  await h.worker.tick();
  assert.deepEqual(h.calls, []);
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  assert.deepEqual(h.calls, [
    ["suspend", "suspending"],
    ["join", "invite-a", "joining"],
  ]);
  assert.equal(h.getSaved().checkpoint.priorGoal, "saved");
  await h.worker.tick();
  assert.deepEqual(h.calls.at(-1), ["fight"]);
});

test("a scheduled username waits until a fresh invitation confirms the leader ID", async () => {
  const h = harness();
  assert.equal(h.worker.start({ leaderUsername: "@Alice", bossId: 7 }), true);
  h.worker.observe([h.invitation({ leaderUsername: "other" })], true);
  await h.worker.tick();
  assert.equal(h.getSaved().leaderPlayerId, null);
  assert.deepEqual(h.calls, []);
  h.worker.observe(
    [h.invitation({ leaderUsername: "ALICE", leaderPlayerId: 42 })],
    true,
  );
  assert.equal(h.getSaved().leaderPlayerId, 42);
  await h.worker.tick();
  assert.equal(h.calls.filter((call) => call[0] === "join").length, 1);
  h.worker.observe(
    [
      h.invitation({
        leaderUsername: "alice",
        leaderPlayerId: 43,
        invitationId: "other",
        battleId: "other",
      }),
    ],
    true,
  );
  assert.equal(h.getSaved().leaderPlayerId, 42);
});

test("a lost join reply survives restart and is never submitted a second time", async () => {
  const h = harness();
  h.worker.start({ leaderPlayerId: 42, bossId: 7 });
  h.setJoin("lost");
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "confirming");
  const restored = harness(h.getSaved());
  restored.worker.observe([restored.invitation()], true);
  await restored.worker.tick();
  assert.deepEqual(restored.calls, []);
  restored.setReconciliation("absent");
  await restored.worker.tick();
  assert.equal(restored.getSaved().phase, "waiting");
  assert.equal(restored.calls.filter((call) => call[0] === "join").length, 0);
});

test("outage does not count towards the quiet period and fresh reads are required", async () => {
  const h = harness();
  h.worker.start({ leaderPlayerId: 42, bossId: 7 });
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  h.setBattle("finished");
  await h.worker.tick();
  h.setTime(1_010_000);
  h.worker.observe([], false);
  h.setTime(2_000_000);
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "waiting");
  h.worker.observe([], true);
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "waiting");
  h.setTime(2_601_000);
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "waiting");
  h.worker.observe([], true);
  await h.worker.tick();
  assert.deepEqual(h.calls.at(-1), ["restore", "saved", "restoring"]);
  assert.equal(h.getSaved().phase, "monitoring");
});

test("time while the server was stopped does not count as a quiet period", async () => {
  const h = harness();
  h.worker.start({ leaderPlayerId: 42, bossId: 7 });
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  h.setBattle("finished");
  await h.worker.tick();
  const restored = harness(h.getSaved());
  restored.setTime(2_000_000);
  restored.worker.observe([], true);
  await restored.worker.tick();
  assert.equal(restored.getSaved().phase, "waiting");
  assert.deepEqual(restored.calls, []);
});

test("stopping during a battle preserves the checkpoint until it ends", async () => {
  const h = harness();
  h.worker.start({ leaderPlayerId: 42, bossId: 7 });
  h.worker.observe([h.invitation()], true);
  await h.worker.tick();
  h.worker.stop();
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "fighting");
  assert.ok(h.getSaved().checkpoint);
  h.setBattle("finished");
  await h.worker.tick();
  assert.equal(h.getSaved().phase, "idle");
  assert.equal(h.getSaved().checkpoint, null);
});

test("durability failure prevents the suspend and join effects", async () => {
  let writes = 0;
  let effects = 0;
  const worker = createRaidSubscription({
    now: () => 1000,
    persist: () => ++writes < 3,
    lock: () => true,
    unlock: () => {},
    capture: () => ({ priorGoal: "saved" }),
    suspend: () => {
      effects++;
      return true;
    },
    join: async () => {
      effects++;
    },
    reconcile: async () => "unknown",
    battle: () => "finished",
    fight: async () => {},
    restore: async () => true,
  });
  worker.start({ leaderPlayerId: 42, bossId: 7 });
  worker.observe(
    [
      {
        leaderPlayerId: 42,
        bossId: 7,
        invitationId: "i",
        battleId: "b",
        available: true,
        expiresAt: 2000,
      },
    ],
    true,
  );
  await assert.rejects(worker.tick(), /subscription_storage_unavailable/);
  assert.equal(effects, 0);
});

test("stop while joining still reconciles an uncertain result before restoration", async () => {
  let release;
  let state;
  const calls = [];
  const worker = createRaidSubscription({
    now: () => 1000,
    persist: (value) => {
      state = structuredClone(value);
    },
    lock: () => true,
    unlock: () => {},
    capture: () => ({ priorGoal: "saved" }),
    suspend: () => true,
    join: () =>
      new Promise((resolve, reject) => {
        release = () => reject(new Error("lost"));
      }),
    reconcile: async () => "absent",
    battle: () => "finished",
    fight: async () => {},
    restore: async () => {
      calls.push("restore");
      return true;
    },
  });
  worker.start({ leaderPlayerId: 42, bossId: 7 });
  worker.observe(
    [
      {
        leaderPlayerId: 42,
        bossId: 7,
        invitationId: "i",
        battleId: "b",
        available: true,
        expiresAt: 2000,
      },
    ],
    true,
  );
  const pending = worker.tick();
  await Promise.resolve();
  worker.stop();
  assert.equal(state.phase, "joining");
  release();
  await pending;
  assert.equal(state.phase, "confirming");
  assert.deepEqual(calls, []);
  await worker.tick();
  assert.deepEqual(calls, ["restore"]);
  assert.equal(state.phase, "idle");
});

test("Buddy selects verified inviters in priority order across all bosses", async () => {
  const h = harness();
  assert.equal(h.worker.setBuddyFriends([42, 43]), true);
  h.worker.observe(
    [
      h.invitation({ inviterPlayerId: 43, bossId: 8, invitationId: "second" }),
      h.invitation({ inviterPlayerId: 42, bossId: 9, invitationId: "first" }),
      h.invitation({
        leaderPlayerId: 42,
        inviterPlayerId: null,
        invitationId: "unknown",
      }),
    ],
    true,
  );
  await h.worker.tick();
  assert.deepEqual(h.calls.at(-1), ["join", "first", "joining"]);
  assert.equal(h.getSaved().bossId, 9);
  assert.equal(h.getSaved().activeFriendId, 42);
});

test("Buddy selection survives restart and disabling does not interrupt a battle", async () => {
  const h = harness();
  h.worker.setBuddyFriends([42, 43]);
  h.worker.observe([h.invitation({ inviterPlayerId: 42 })], true);
  await h.worker.tick();
  const restored = harness(h.getSaved());
  assert.deepEqual(restored.getSaved().friendIds, [42, 43]);
  restored.setBattle("active");
  assert.equal(restored.worker.setBuddyFriends([]), true);
  await restored.worker.tick();
  assert.equal(restored.getSaved().phase, "fighting");
  restored.setBattle("finished");
  await restored.worker.tick();
  assert.equal(restored.getSaved().phase, "idle");
});

test("Buddy remembers attempted invitations and gives another friend a turn", async () => {
  const h = harness();
  h.worker.setBuddyFriends([42, 43]);
  const first = h.invitation({
    inviterPlayerId: 42,
    invitationId: "one",
    battleId: "one-battle",
  });
  const again = h.invitation({
    inviterPlayerId: 42,
    invitationId: "two",
    battleId: "two-battle",
  });
  const other = h.invitation({
    inviterPlayerId: 43,
    invitationId: "three",
    battleId: "three-battle",
  });
  h.worker.observe([first], true);
  await h.worker.tick();
  h.setBattle("finished");
  h.worker.observe([first, again, other], true);
  await h.worker.tick();
  assert.equal(h.calls.filter((call) => call[0] === "join").at(-1)[1], "three");
  const restored = harness(h.getSaved());
  restored.setBattle("finished");
  restored.worker.observe([first, again, other], true);
  await restored.worker.tick();
  assert.equal(
    restored.calls.filter((call) => call[0] === "join").at(-1)[1],
    "two",
  );
});

test("stopping floor automation while Buddy is fighting clears the saved floor-owned work", async () => {
  const saved = {
    mode: "buddy",
    enabled: true,
    phase: "fighting",
    friendIds: [42],
    battleId: "battle",
    bossId: 7,
    lastReadAt: 1000000,
    lastSeenAt: 1000000,
    offlineAt: null,
    checkpoint: {
      floorOwned: true,
      bossId: 7,
      goal: { status: "active" },
      auto: { enabled: true },
      raidEnabled: true,
      businessRunning: false,
      workRunning: false,
    },
  };
  const h = harness(saved);
  h.worker.discardFloorCheckpoint();
  assert.equal(h.getSaved().checkpoint.floorOwned, false);
  assert.equal(h.getSaved().checkpoint.raidEnabled, false);
  assert.equal(h.getSaved().checkpoint.goal, null);
  assert.equal(h.getSaved().checkpoint.auto, null);
  assert.equal(h.getSaved().phase, "fighting");
});
