import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";

test("shared queue cooldown survives reopening the state database", () => {
  const directory = mkdtempSync(join(tmpdir(), "queue-cooldown-"));
  try {
    const first = createAutomationStateStore({ directory });
    assert.deepEqual(first.getQueueCooldown(), { readyAt: 0, failures: 0 });
    first.acquireLease("first", 1000, 1000);
    first.setQueueCooldown(123456, 3, "first", 1000);
    first.close();
    const second = createAutomationStateStore({ directory });
    assert.deepEqual(second.getQueueCooldown(), {
      readyAt: 123456,
      failures: 3,
    });
    assert.throws(
      () => second.setQueueCooldown(-1, 0, "first", 1000),
      TypeError,
    );
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a new lease owner observes the prior owner's shared cooldown", () => {
  const directory = mkdtempSync(join(tmpdir(), "queue-cooldown-lease-"));
  const first = createAutomationStateStore({ directory });
  const second = createAutomationStateStore({ directory });
  try {
    assert.equal(first.acquireLease("first", 1000, 1000), true);
    assert.equal(second.acquireLease("second", 1500, 1000), false);
    first.setQueueCooldown(9000, 2, "first", 1500);
    assert.equal(second.acquireLease("second", 2000, 1000), true);
    assert.throws(
      () => first.setQueueCooldown(0, 0, "first", 2000),
      /automation_worker_unavailable/,
    );
    assert.deepEqual(second.getQueueCooldown(), { readyAt: 9000, failures: 2 });
    assert.equal(first.releaseLease("first"), false);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
