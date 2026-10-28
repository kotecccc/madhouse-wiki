import test from "node:test";
import assert from "node:assert/strict";
import {
  PULL_THRESHOLD,
  resistedPull,
  accumulateWheel,
  beginWheelSequence,
} from "./pull-refresh-motion.js";

test("pull starts gently and requires deliberate movement", () => {
  assert.equal(resistedPull(12), 0);
  assert.ok(resistedPull(40) < 20);
  assert.ok(resistedPull(100) < PULL_THRESHOLD);
  assert.ok(resistedPull(160) < PULL_THRESHOLD);
  assert.ok(resistedPull(180) < PULL_THRESHOLD);
  assert.ok(resistedPull(240) > PULL_THRESHOLD);
  assert.ok(resistedPull(10000) <= 120);
});

test("a single wheel notch cannot reach the refresh threshold", () => {
  for (const [delta, mode] of [
    [-120, 0],
    [-3, 1],
    [-1, 2],
  ]) {
    const distance = accumulateWheel(0, delta, mode, 900);
    assert.ok(resistedPull(distance * 0.7) < PULL_THRESHOLD);
  }
  let distance = 0;
  for (let i = 0; i < 8; i++)
    distance = accumulateWheel(distance, -120, 0, 900);
  assert.ok(resistedPull(distance * 0.7) > PULL_THRESHOLD);
});

test("scrolling to the top cannot turn the same wheel gesture into a refresh", () => {
  const sequence = beginWheelSequence(null, false);
  assert.equal(beginWheelSequence(sequence, true).eligible, false);
  assert.equal(beginWheelSequence(null, true).eligible, true);
});
