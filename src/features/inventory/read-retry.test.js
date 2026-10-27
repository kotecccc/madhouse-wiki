import assert from "node:assert/strict";
import test from "node:test";
import {
  INVENTORY_READ_RETRY_INTERVAL_MS,
  runInventoryReadAttempts,
  readInventorySnapshot,
  readTattooZone,
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

test("stale inventory snapshot is displayed before one explicit refresh", async () => {
  const calls = [];
  const shown = [];
  const result = await readInventorySnapshot({
    read: async (fresh) => {
      calls.push(fresh);
      return fresh ? "updated" : "saved";
    },
    isFresh: () => false,
    onSnapshot: (value) => shown.push(value),
  });
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(shown, ["saved"]);
  assert.equal(result, "updated");
});

test("fresh inventory snapshot does not trigger a live refresh", async () => {
  const calls = [];
  await readInventorySnapshot({
    read: async (fresh) => calls.push(fresh),
    isFresh: () => true,
    onSnapshot: () => assert.fail("fresh snapshot is returned directly"),
  });
  assert.deepEqual(calls, [false]);
});

test("tattoo zones reuse fresh memory and request a stale or missing zone only once", async () => {
  const calls = [];
  const read = async () => {
    calls.push("server");
    return { items: [1] };
  };
  const cached = { items: [2] };
  assert.equal(await readTattooZone({ peekFresh: () => cached, read }), cached);
  assert.deepEqual(calls, []);
  assert.deepEqual(await readTattooZone({ peekFresh: () => null, read }), {
    items: [1],
  });
  assert.deepEqual(calls, ["server"]);
});
