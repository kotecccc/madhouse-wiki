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
