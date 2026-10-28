import assert from "node:assert/strict";
import test from "node:test";
import { createRaidWaiter } from "../scripts/automation/raid-waiter.mjs";

function setup({
  saved,
  refresh,
  startSolo,
  priorityActive = () => false,
  workPriority = () => false,
} = {}) {
  let clock = 1000,
    locked = false,
    enabled = false;
  const state = { boss: { id: 7 }, battle: null };
  const goal = { status: "active" };
  const calls = [];
  const autoStarts = [];
  const refreshOptions = [];
  let items = [];
  const worker = createRaidWaiter({
    saved,
    now: () => clock,
    state: () => state,
    goal: {
      getSnapshot: () => goal,
      stop() {
        goal.status = "stopped";
      },
    },
    auto: {
      getSnapshot: () => ({ enabled }),
      start(options) {
        autoStarts.push(options);
        calls.push("auto.start");
        enabled = true;
        return true;
      },
      stop() {
        enabled = false;
      },
      finishCurrent() {
        calls.push("auto.finishCurrent");
        return true;
      },
      resumeSeries(options) {
        autoStarts.push(options);
        return true;
      },
    },
    available: () => !priorityActive(),
    priorityActive,
    workPriority,
    lock() {
      if (locked) return false;
      locked = true;
      return true;
    },
    unlock() {
      locked = false;
    },
    async refresh(options) {
      calls.push("refresh");
      refreshOptions.push(options);
      await refresh?.();
    },
    invitations: () => items,
    async accept(id, allowed) {
      assert.equal(allowed(), true);
      calls.push(id);
      state.invitationOnly = true;
      state.battle = { id: "fight-7", status: "active" };
    },
    startSolo,
    onChange() {},
  });
  return {
    worker,
    state,
    goal,
    calls,
    autoStarts,
    refreshOptions,
    setItems(value) {
      items = value;
    },
    advance(ms = 10000) {
      clock += ms;
    },
    finish() {
      state.battle.status = "won";
      enabled = false;
    },
  };
}
test("raid start receipts survive actor replacement and reload", () => {
  const h = setup();
  assert.equal(h.worker.start(7, { queueId: "raid-old" }), true);
  h.worker.stop();
  assert.equal(h.worker.start(7, { queueId: "raid-new" }), true);
  const saved = structuredClone(h.worker.getSnapshot());
  assert.deepEqual(saved.startReceipts, ["raid-old", "raid-new"]);
  const restored = setup({ saved });
  assert.deepEqual(
    restored.worker.getSnapshot().startReceipts,
    saved.startReceipts,
  );
});

const invitation = {
  invitationId: "invite-7",
  bossId: 7,
  battleId: "fight-7",
  available: true,
  expiresAt: 999999,
};

test("resuming a finishing raid keeps the current battle as the only fight", async () => {
  const ctx = setup();
  ctx.worker.start(7);
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  ctx.worker.finishAfterCurrent();
  assert.equal(ctx.worker.resumePaused(), true);
  assert.deepEqual(ctx.autoStarts, [
    { singleBattle: true },
    { singleBattle: true },
  ]);
});

test("a ready farm delays solo fights while a live invitation can still be accepted", async () => {
  let soloStarts = 0;
  const h = setup({
    workPriority: () => true,
    startSolo: async () => {
      soloStarts++;
    },
  });
  h.worker.start(7);
  await h.worker.tick();
  assert.equal(soloStarts, 0);
  assert.equal(h.worker.getSnapshot().status, "waiting");
  h.setItems([invitation]);
  h.advance();
  await h.worker.tick();
  assert.equal(soloStarts, 0);
  assert.ok(h.calls.includes("invite-7"));
  assert.ok(h.calls.includes("auto.start"));
});

test("a waiting raid can be suspended and resumed without losing its intent", async () => {
  const ctx = setup();
  ctx.worker.start(7);
  const saved = structuredClone(ctx.worker.getSnapshot());
  assert.equal(ctx.worker.suspend(), true);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, []);
  assert.deepEqual(ctx.worker.getSnapshot(), saved);
  ctx.worker.resume();
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh"]);
});

test("raid suspension waits for an active battle or uncertain operation", () => {
  const ctx = setup();
  ctx.worker.start(7);
  ctx.state.battle = { id: "fight-7", status: "active" };
  assert.equal(ctx.worker.suspend(), false);
  ctx.state.battle = null;
  ctx.state.pendingInvitation = { invitationId: "invite-7" };
  assert.equal(ctx.worker.suspend(), false);
  assert.equal(ctx.worker.getSnapshot().enabled, true);
});

test("raid waits on server, filters boss, joins once, attacks and waits again without solo start", async () => {
  const ctx = setup();
  assert.equal(ctx.worker.start(7), true);
  ctx.setItems([{ ...invitation, bossId: 8 }]);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh"]);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh"]);
  ctx.advance();
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh", "refresh", "invite-7", "auto.start"]);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "fighting");
  ctx.finish();
  ctx.advance();
  ctx.setItems([]);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "waiting");
  ctx.goal.status = "completed";
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, false);
});

test("raid force-checks invitations immediately after a fight ends", async () => {
  const ctx = setup();
  assert.equal(ctx.worker.start(7), true);
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh", "invite-7", "auto.start"]);

  ctx.finish();
  ctx.advance(1000);
  ctx.setItems([]);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "waiting");

  ctx.advance(1000);
  ctx.setItems([invitation]);
  await ctx.worker.tick();

  assert.deepEqual(ctx.calls, [
    "refresh",
    "invite-7",
    "auto.start",
    "refresh",
    "refresh",
    "invite-7",
    "auto.start",
  ]);
  assert.deepEqual(ctx.refreshOptions, [
    { force: false },
    { force: true },
    { force: true },
  ]);
  assert.equal(ctx.worker.getSnapshot().status, "fighting");
});

test("stop during pending invitation read prevents joining and concurrent ticks serialize", async () => {
  let resolve;
  const ctx = setup({
    refresh: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  ctx.worker.start(7);
  ctx.setItems([invitation]);
  const pending = ctx.worker.tick();
  await ctx.worker.tick();
  ctx.worker.stop();
  resolve();
  await pending;
  assert.deepEqual(ctx.calls, ["refresh"]);
  assert.equal(ctx.worker.getSnapshot().enabled, false);
});

test("stopping a raid keeps attacks running until the current fight ends", async () => {
  const ctx = setup();
  ctx.worker.start(7);
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  ctx.worker.finishAfterCurrent();
  assert.equal(ctx.worker.getSnapshot().stopAfterBattle, true);
  assert.equal(ctx.goal.status, "active");
  assert.equal(ctx.calls.at(-1), "auto.finishCurrent");
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  ctx.finish();
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, false);
  assert.equal(ctx.goal.status, "stopped");
  assert.equal(ctx.calls.filter((call) => call === "invite-7").length, 1);
});

test("stopping before any fight ends the raid without starting one", async () => {
  const ctx = setup();
  ctx.worker.start(7);
  ctx.worker.finishAfterCurrent();
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, false);
  assert.equal(ctx.goal.status, "stopped");
  assert.deepEqual(ctx.calls, []);
});

test("uncertain restart checkpoint pauses and never accepts again", async () => {
  const ctx = setup({ saved: { enabled: true, status: "joining", bossId: 7 } });
  ctx.state.pendingInvitation = invitation;
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, []);
  ctx.worker.resume();
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "waiting_confirmation");
  assert.deepEqual(ctx.calls, []);
});

test("confirmed waiting intent resumes after restart and deadline stops polling", async () => {
  const ctx = setup({ saved: { enabled: true, status: "waiting", bossId: 7 } });
  ctx.worker.resume();
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh"]);
  ctx.goal.status = "expired";
  ctx.advance();
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "expired");
  assert.deepEqual(ctx.calls, ["refresh"]);
});

test("read failure keeps raid enabled and a later read recovers without mutation retry", async () => {
  let fail = true;
  const ctx = setup({
    refresh: () => {
      if (fail) throw new Error("offline");
    },
  });
  ctx.worker.start(7);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  ctx.advance(30000);
  fail = false;
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "fighting");
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  assert.deepEqual(ctx.calls, ["refresh", "refresh", "invite-7", "auto.start"]);
});

test("a successful state refresh clears a temporary error and resumes invitation polling immediately", async () => {
  let fail = true;
  const ctx = setup({
    refresh: () => {
      if (fail) throw new Error("offline");
      delete ctx.state.error;
    },
  });
  ctx.worker.start(7);
  ctx.state.error = "temporary_state_error";
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  ctx.advance(30000);
  fail = false;
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "fighting");
  assert.deepEqual(ctx.calls, [
    "refresh",
    "refresh",
    "refresh",
    "invite-7",
    "auto.start",
  ]);
});

test("restored legacy raid never starts solo without an invitation", async () => {
  let starts = 0;
  const ctx = setup({
    saved: {
      enabled: true,
      status: "waiting",
      bossId: 7,
      allowSolo: true,
      nextCheckAt: 0,
    },
    startSolo: async () => {
      starts++;
    },
  });
  ctx.worker.resume();
  await ctx.worker.tick();
  ctx.advance();
  await ctx.worker.tick();
  assert.equal(starts, 0);
  assert.deepEqual(ctx.calls, ["refresh", "refresh"]);
  ctx.setItems([invitation]);
  ctx.advance();
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls.slice(-2), ["invite-7", "auto.start"]);
  assert.deepEqual(ctx.autoStarts, [{ singleBattle: true }]);
});

test("invitation discovery failure never starts a fight or accepts stale invitations", async () => {
  let starts = 0;
  const ctx = setup({
    saved: {
      enabled: true,
      status: "waiting",
      bossId: 7,
      allowSolo: true,
      nextCheckAt: 0,
    },
    refresh: async () => {
      throw new Error("invitations offline");
    },
    startSolo: async () => {
      starts++;
    },
  });
  ctx.worker.resume();
  ctx.setItems([invitation]);
  await ctx.worker.tick();
  assert.equal(starts, 0);
  assert.deepEqual(ctx.calls, ["refresh"]);
});

test("raid waits through character priority and resumes its checks", async () => {
  let priority = true;
  const ctx = setup({ priorityActive: () => priority });
  ctx.worker.start(7);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, []);
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  priority = false;
  ctx.advance(1000);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh"]);
});

test("user pause survives restart and resumes through a fresh read", async () => {
  const first = setup();
  first.worker.start(7);
  assert.equal(first.worker.pause(), true);
  const saved = structuredClone(first.worker.getSnapshot());
  const restored = setup({ saved });
  await restored.worker.tick();
  assert.equal(restored.worker.getSnapshot().userPaused, true);
  assert.deepEqual(restored.calls, []);
  assert.equal(restored.worker.resumePaused(), true);
  await restored.worker.tick();
  assert.equal(restored.worker.getSnapshot().enabled, true);
  assert.deepEqual(restored.calls, ["refresh"]);
});

test("resume waits for the read that was in flight when the raid was paused", async () => {
  let release;
  let first = true;
  const ctx = setup({
    refresh: () =>
      first
        ? ((first = false),
          new Promise((resolve) => {
            release = resolve;
          }))
        : undefined,
  });
  ctx.worker.start(7);
  ctx.setItems([invitation]);
  const tick = ctx.worker.tick();
  assert.equal(ctx.worker.pause(), true);
  assert.equal(ctx.worker.resumePaused(), true);
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().enabled, false);
  release();
  await tick;
  assert.deepEqual(ctx.calls, ["refresh"]);
  await ctx.worker.tick();
  assert.deepEqual(ctx.calls, ["refresh", "refresh", "invite-7", "auto.start"]);
});
