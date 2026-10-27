import test from "node:test";
import assert from "node:assert/strict";
import { createModalRefreshGate } from "./pull-refresh.js";

test("modal refresh blocks simultaneous calls and enforces cooldown across reopen", async () => {
  let time = 1000;
  let release;
  let calls = 0;
  const gate = createModalRefreshGate({ now: () => time, interval: 10000 });
  const task = gate("test-modal-refresh", () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  assert.equal(
    await gate("test-modal-refresh", () => {
      calls++;
    }),
    false,
  );
  release();
  assert.equal(await task, true);
  time += 9999;
  assert.equal(
    await gate("test-modal-refresh", () => {
      calls++;
    }),
    false,
  );
  time++;
  assert.equal(
    await gate("test-modal-refresh", () => {
      calls++;
    }),
    true,
  );
  assert.equal(calls, 2);
});

test("failed refresh is not replayed and becomes available after cooldown", async () => {
  let time = 1;
  const gate = createModalRefreshGate({ now: () => time, interval: 100 });
  await assert.rejects(
    gate("failed-modal-refresh", async () => {
      throw new Error("failed");
    }),
  );
  assert.equal(await gate("failed-modal-refresh", () => {}), false);
  time += 100;
  assert.equal(await gate("failed-modal-refresh", () => {}), true);
});
