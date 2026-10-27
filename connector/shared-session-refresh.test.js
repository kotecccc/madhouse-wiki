import test from "node:test";
import assert from "node:assert/strict";
import {
  silentlyRefreshActiveBossBattle,
  silentlyRefreshSharedSessionData,
} from "./shared-session-refresh.js";

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

test("shared refresh returns fresh validated progress without exposing the token", async () => {
  const result = await silentlyRefreshSharedSessionData(async () => ({
    status: "connected",
    accessToken: "secret-token",
    playerLevel: 136,
    currentExp: 42,
    expToNextLevel: 350,
    activeBossBattle: null,
    ignored: "field",
  }));

  assert.deepEqual(result, {
    playerLevel: 136,
    currentExp: 42,
    expToNextLevel: 350,
    activeBossBattle: null,
  });
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
});

test("shared refresh omits partial progress so the shared snapshot remains the fallback", async () => {
  const result = await silentlyRefreshSharedSessionData(async () => ({
    status: "connected",
    playerLevel: 136,
    currentExp: 42,
  }));

  assert.deepEqual(result, { activeBossBattle: null });
});

test("shared refresh outage returns null so the caller can keep shared progress", async () => {
  assert.equal(
    await silentlyRefreshSharedSessionData(async () => {
      throw new Error("game_unavailable");
    }),
    null,
  );
});

test("silent refresh propagates route and Wiki identity denials", async () => {
  for (const code of [
    "bridge_auth_required",
    "bridge_route_unavailable",
    "invalid_wiki_identity",
    "try_later",
  ]) {
    await assert.rejects(
      silentlyRefreshActiveBossBattle(async () => {
        throw new Error(code);
      }),
      new RegExp(code),
    );
  }
});
