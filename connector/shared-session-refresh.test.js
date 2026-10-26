import test from "node:test";
import assert from "node:assert/strict";
import { silentlyRefreshActiveBossBattle } from "./shared-session-refresh.js";

test("silent refresh returns a normalized active battle from fresh game auth", async () => {
  let calls = 0;
  const battle = await silentlyRefreshActiveBossBattle(async () => {
    calls++;
    return {
      status: "connected",
      activeBossBattle: {
        battleId: "battle_1",
        bossId: "7",
        expiresAtUtc: "2026-10-26T12:00:00Z",
        remainingSeconds: 60,
        ignored: true,
      },
    };
  });
  assert.equal(calls, 1);
  assert.deepEqual(battle, {
    battleId: "battle_1",
    bossId: 7,
    expiresAtUtc: "2026-10-26T12:00:00Z",
    remainingSeconds: 60,
  });
});

test("silent refresh omits the ref when there is no active fight", async () => {
  assert.equal(
    await silentlyRefreshActiveBossBattle(async () => ({
      status: "connected",
    })),
    null,
  );
});

test("silent refresh falls back without interactive login for missing Telegram auth", async () => {
  for (const status of ["login-required", "password-required"]) {
    let calls = 0;
    const result = await silentlyRefreshActiveBossBattle(async () => {
      calls++;
      return { status };
    });
    assert.equal(result, null);
    assert.equal(calls, 1);
  }
});

test("silent refresh falls back after an exchange error", async () => {
  assert.equal(
    await silentlyRefreshActiveBossBattle(async () => {
      throw new Error("game_unavailable");
    }),
    null,
  );
});
