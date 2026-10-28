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
