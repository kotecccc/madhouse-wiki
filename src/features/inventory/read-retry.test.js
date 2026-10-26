import assert from "node:assert/strict";
import test from "node:test";
import {
  INVENTORY_READ_RETRY_INTERVAL_MS,
  runInventoryReadAttempts,
} from "./read-retry.js";

test("inventory retries a failed or stale health response at 15-second intervals, up to success", async () => {
  const delays = [];
  const attempts = [];
  const result = await runInventoryReadAttempts({
    read: async (attempt) => {
      attempts.push(attempt);
      return { stale: attempt < 3 };
    },
    isFailedResponse: (data) => data.stale,
    wait: async (delay) => {
      delays.push(delay);
      return true;
    },
  });

  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [
    INVENTORY_READ_RETRY_INTERVAL_MS,
    INVENTORY_READ_RETRY_INTERVAL_MS,
  ]);
  assert.deepEqual(result, {
    status: "ready",
    data: { stale: false },
    attempts: 3,
  });
});

test("inventory retry stops on cancellation and caps unresolved failures at three attempts", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const cancelled = await runInventoryReadAttempts({
    read: async () => {
      attempts += 1;
      throw new Error("temporary failure");
    },
    wait: async () => {
      controller.abort();
      return false;
    },
    signal: controller.signal,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(attempts, 1);

  const failures = await runInventoryReadAttempts({
    read: async () => {
      attempts += 1;
      throw new Error("temporary failure");
    },
    wait: async () => true,
  });
  assert.equal(failures.status, "error");
  assert.equal(failures.attempts, 3);
});

test("permanent request failures and late cancelled replies never trigger another request", async () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const result = await runInventoryReadAttempts({
      read: async () => {
        throw Object.assign(new Error("not retryable"), { status });
      },
      wait: async () => {
        throw new Error("must not wait");
      },
    });
    assert.equal(result.attempts, 1);
  }
  const controller = new AbortController();
  let published = false;
  const result = await runInventoryReadAttempts({
    signal: controller.signal,
    read: async () => {
      controller.abort();
      return { account: "old" };
    },
    onData: () => {
      published = true;
    },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(published, false);
});
