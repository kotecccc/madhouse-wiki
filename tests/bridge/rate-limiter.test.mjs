import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeRateLimiter } from "../../scripts/bridge/rate-limiter.mjs";

test("limits each trusted peer and endpoint without evicting live buckets", () => {
  let time = 100;
  const limiter = createBridgeRateLimiter({ now: () => time, capacity: 2 });
  for (let i = 0; i < 12; i += 1)
    assert.equal(limiter.consume("127.0.0.1", "/api/bridge/redeem"), true);
  assert.equal(limiter.consume("127.0.0.1", "/api/bridge/redeem"), false);
  assert.equal(limiter.consume("127.0.0.2", "/api/bridge/redeem"), true);
  assert.equal(limiter.consume("127.0.0.3", "/api/bridge/redeem"), false);
  time += 60_000;
  assert.equal(limiter.consume("127.0.0.3", "/api/bridge/redeem"), true);
});

test("rejects untrusted addresses, unknown endpoints and a backwards clock", () => {
  let time = 100;
  const limiter = createBridgeRateLimiter({ now: () => time });
  assert.equal(limiter.consume("not-an-ip", "/bridge/data"), false);
  assert.equal(limiter.consume("127.0.0.1", "/other"), false);
  assert.equal(limiter.consume("::1", "/bridge/data"), true);
  time -= 1;
  assert.equal(limiter.consume("::1", "/bridge/data"), false);
});

test("authenticated device reconnects have independent limits behind a shared proxy", () => {
  const limiter = createBridgeRateLimiter({ now: () => 100 });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  for (let i = 0; i < 30; i++)
    assert.equal(limiter.consume("127.0.0.1", "/bridge/data"), true);
  assert.equal(limiter.consume("127.0.0.1", "/bridge/data"), false);
  for (let i = 0; i < 100; i++)
    assert.equal(limiter.consume("127.0.0.1", "/bridge/data", first), true);
  assert.equal(limiter.consume("127.0.0.1", "/bridge/data", second), true);
  assert.equal(limiter.consume("127.0.0.1", "/bridge/data", "invalid"), false);
});
