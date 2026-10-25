import test from "node:test";
import assert from "node:assert/strict";
import {
  readRetryStartedAt,
  retrySeconds,
  writeRetryStartedAt,
} from "../shared/retry-countdown.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

test("retry seconds rounds up and stays within the 60 second duration", () => {
  assert.equal(retrySeconds(60_000, 0), 60);
  assert.equal(retrySeconds(60_001, 0), 60);
  assert.equal(retrySeconds(59_001, 1), 59);
  assert.equal(retrySeconds(59_000, 1_000), 58);
  assert.equal(retrySeconds(1, 1), 0);
  assert.equal(retrySeconds(1, 2), 0);
  assert.equal(retrySeconds(Number.NaN, 0), 0);
});

test("timestamp persists across storage reads and remaining time transitions correctly", () => {
  const storage = memoryStorage();
  assert.equal(writeRetryStartedAt("retry", 1_000, storage), true);
  assert.equal(storage.getItem("retry"), "1000");
  const startedAt = readRetryStartedAt("retry", storage, 1_000);
  assert.equal(startedAt, 1_000);
  assert.equal(retrySeconds(startedAt + 60_000, 1_000), 60);
  assert.equal(retrySeconds(startedAt + 60_000, 2_000), 59);
  assert.equal(retrySeconds(startedAt + 60_000, 61_000), 0);
  assert.equal(readRetryStartedAt("retry", storage, 61_001), 0);
  assert.equal(storage.getItem("retry"), null);
});

test("expiry, corrupt, future and blocked storage fail closed", () => {
  const storage = memoryStorage({
    expired: "1000",
    corrupt: "nope",
    decimal: "1000.5",
    future: "3000",
  });
  assert.equal(readRetryStartedAt("expired", storage, 61_001), 0);
  assert.equal(storage.getItem("expired"), null);
  assert.equal(readRetryStartedAt("corrupt", storage, 2_000), 0);
  assert.equal(storage.getItem("corrupt"), null);
  assert.equal(readRetryStartedAt("decimal", storage, 2_000), 0);
  assert.equal(readRetryStartedAt("future", storage, 2_000), 0);

  const blocked = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
    removeItem() {
      throw new Error("blocked");
    },
  };
  assert.equal(readRetryStartedAt("retry", blocked, 2_000), 0);
  assert.equal(writeRetryStartedAt("retry", 2_000, blocked), false);
});
