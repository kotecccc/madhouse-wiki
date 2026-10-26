import test from "node:test";
import assert from "node:assert/strict";
import { refreshRetainedProfileProgress } from "../shared/profile-progress.js";
const progress = { playerLevel: 136, currentExp: 42, expToNextLevel: 500 };

test("optional restoration updates only progress for the verified account", async () => {
  let applied;
  assert.equal(
    await refreshRetainedProfileProgress({
      telegramId: 123,
      request: async (id) => {
        assert.equal(id, "123");
        return {
          status: "connected",
          ...progress,
          accessToken: "never-replace",
        };
      },
      isCurrent: () => true,
      apply: (value) => {
        applied = value;
      },
    }),
    true,
  );
  assert.deepEqual(applied, progress);
});
test("missing Telegram session or game outage cannot replace or clear an existing JWT", async () => {
  for (const result of [
    { status: "login-required" },
    { status: "pending" },
    null,
  ]) {
    assert.equal(
      await refreshRetainedProfileProgress({
        telegramId: 123,
        request: async () => {
          if (!result) throw new Error("offline");
          return result;
        },
        isCurrent: () => true,
        apply: () => {
          throw new Error("must not change session");
        },
      }),
      false,
    );
  }
});
test("account switch during a refresh and incomplete progress are ignored", async () => {
  let applied = false;
  for (const current of [true, false]) {
    const result = current
      ? { status: "connected", playerLevel: 136 }
      : { status: "connected", ...progress };
    assert.equal(
      await refreshRetainedProfileProgress({
        telegramId: 123,
        request: async () => result,
        isCurrent: () => current,
        apply: () => {
          applied = true;
        },
      }),
      false,
    );
  }
  assert.equal(applied, false);
});
