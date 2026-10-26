import assert from "node:assert/strict";
import test from "node:test";
import { createRaidWaiter } from "../scripts/automation/raid-waiter.mjs";

function setup({ saved, refresh } = {}) {
  let clock = 1000,
    locked = false,
    enabled = false;
  const state = { boss: { id: 7 }, battle: null };
  const goal = { status: "active" };
  const calls = [];
  const refreshOptions = [];
  let items = [];
  const worker = createRaidWaiter({
    saved,
    now: () => clock,
    state: () => state,
    goal: { getSnapshot: () => goal },
    auto: {
      getSnapshot: () => ({ enabled }),
      start() {
        calls.push("auto.start");
        enabled = true;
        return true;
      },
      stop() {
        enabled = false;
      },
    },
    available: () => true,
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
    onChange() {},
  });
  return {
    worker,
    state,
    goal,
    calls,
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
const invitation = {
  invitationId: "invite-7",
  bossId: 7,
  battleId: "fight-7",
  available: true,
  expiresAt: 999999,
};

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

test("read failure keeps raid enabled and backs off without retrying mutations", async () => {
  const ctx = setup({
    refresh: () => {
      throw new Error("offline");
    },
  });
  ctx.worker.start(7);
  await ctx.worker.tick();
  ctx.advance();
  await ctx.worker.tick();
  assert.equal(ctx.worker.getSnapshot().status, "waiting");
  assert.equal(ctx.worker.getSnapshot().enabled, true);
  assert.deepEqual(ctx.calls, ["refresh"]);
});
