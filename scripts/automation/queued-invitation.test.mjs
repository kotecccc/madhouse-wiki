import test from "node:test";
import assert from "node:assert/strict";
import { queuedInvitationAdapter } from "./queued-invitation.mjs";

for (const [status, reason] of [
  [401, "game_session_required"],
  [400, "game_request_rejected"],
]) {
  for (const submitted of [false, true])
    test(`invitation ${status} ${submitted ? "after" : "before"} submission retains the right outcome`, async () => {
      const entry = {
        controller: { getSnapshot: () => ({}) },
        manualBattle: { pending: null, receipts: [] },
      };
      const adapter = queuedInvitationAdapter({
        entry,
        save: () => {},
        now: () => 1000,
        accept: async (_id, _allowed, _args, beforeSend) => {
          if (submitted) beforeSend({ operationId: "operation-1" });
          throw Object.assign(new Error("rejected"), { status });
        },
      });
      const job = {
        id: "invitation-01",
        args: {
          invitationId: "invite-1",
          battleId: "battle-1",
          bossId: 7,
          expiresAt: 5000,
        },
      };
      const result = await adapter.execute(job, { canDispatch: () => true });
      assert.equal(result.status, submitted ? "uncertain" : "failed");
      if (!submitted) assert.equal(result.reason, reason);
      assert.equal(Boolean(entry.manualBattle.pending), submitted);
    });
}

test("an expired invitation does not resolve a lost acceptance response", async () => {
  let current = { pendingInvitation: null, needsRefresh: false, error: null };
  let sends = 0;
  const job = {
    id: "invitation-01",
    args: {
      invitationId: "invite-1",
      battleId: "battle-1",
      bossId: 7,
      expiresAt: 5000,
    },
  };
  const entry = {
    controller: { getSnapshot: () => current },
    manualBattle: { pending: null, receipts: [] },
  };
  const adapter = queuedInvitationAdapter({
    entry,
    save: () => {},
    now: () => 6000,
    refresh: async () => {},
    accept: async () => {
      sends++;
    },
  });
  entry.manualBattle.pending = {
    id: job.id,
    kind: "invitation",
    battleId: job.args.battleId,
  };
  assert.equal((await adapter.reconcile(job)).status, "uncertain");
  assert.equal(entry.manualBattle.pending.id, job.id);
  assert.equal(sends, 0);
  current = {
    ...current,
    invitationOnly: true,
    boss: { id: 7 },
    battle: { id: "battle-1" },
  };
  assert.equal((await adapter.reconcile(job)).status, "completed");
  assert.equal(entry.manualBattle.pending, null);
  assert.equal(sends, 0);
});
