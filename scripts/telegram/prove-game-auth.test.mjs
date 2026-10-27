import test from "node:test";
import assert from "node:assert/strict";
import { proveGameAuth } from "./prove-game-auth.mjs";

const initData = `auth_date=${Math.floor(Date.now() / 1000)}&hash=fixture&user=private-fixture`;

test("clean login has no Bearer; returned token is used only for /me and never in proof", async () => {
  const calls = [];
  const proof = await proveGameAuth(initData, async (url, options) => {
    calls.push({ url, options });
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? { accessToken: "private-test-token" }
          : { id: "private-test-id" },
      ),
      { status: 200 },
    );
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://cargohustle.online/api/auth/telegram");
  assert.deepEqual(calls[0].options.headers, {
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), { initData });
  assert.equal(calls[1].url, "https://cargohustle.online/api/me");
  assert.equal(
    calls[1].options.headers.Authorization,
    "Bearer private-test-token",
  );
  assert.equal(proof.meStatus, 200);
  assert.equal(proof.meIsObject, true);
  assert.doesNotMatch(JSON.stringify(proof), /private-/);
});

test("auth rejection stops before /me and does not echo arbitrary server errors", async () => {
  let calls = 0;
  const proof = await proveGameAuth(initData, async () => {
    calls++;
    return new Response(JSON.stringify({ error: "private-server-detail" }), {
      status: 401,
    });
  });
  assert.equal(calls, 1);
  assert.equal(proof.error, "auth_rejected");
  assert.equal(proof.accessTokenPresent, false);
  assert.doesNotMatch(JSON.stringify(proof), /private-/);
});

test("known auth failure is reported without retries", async () => {
  const proof = await proveGameAuth(
    initData,
    async () =>
      new Response(JSON.stringify({ error: "telegram_auth_failed" }), {
        status: 401,
      }),
  );
  assert.equal(proof.error, "telegram_auth_failed");
});

test("invalid input is rejected before any network call", async () => {
  await assert.rejects(
    proveGameAuth("user=private", () => assert.fail("must not fetch")),
    /invalid_init_data_shape/,
  );
});

test("default live auth proof requires the explicit runtime gate", async () => {
  const original = process.env.MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF;
  delete process.env.MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF;
  try {
    await assert.rejects(proveGameAuth(initData), {
      message: "live_game_auth_proof_not_enabled",
    });
  } finally {
    if (original === undefined)
      delete process.env.MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF;
    else process.env.MADHOUSE_ENABLE_LIVE_GAME_AUTH_PROOF = original;
  }
});
