import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

async function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "automation-state-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("operator resolution atomically archives only the specified stopped work under the worker lease", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    const pending = {
      kind: "performing",
      operationId: "work-old-123",
      taskId: 2,
      before: { tasks: [{ progress: 5 }] },
    };
    const original = {
      workFarm: { run: { status: "stopped", pending, reconcileFailures: 300 } },
      queuedActions: [],
    };
    store.write(123, original);
    assert.throws(
      () =>
        store.resolveStoppedWorkByOperator(
          123,
          pending.operationId,
          "operator",
          () => 10,
        ),
      /automation_worker_unavailable/,
    );
    assert.equal(store.acquireLease("operator", 10, 1000), true);
    assert.throws(
      () =>
        store.resolveStoppedWorkByOperator(
          123,
          "wrong-id",
          "operator",
          () => 11,
        ),
      /work_resolution_preconditions_failed/,
    );
    assert.deepEqual(store.read(123), original);
    store.write(123, { ...original, queuedActions: [{ status: "running" }] });
    assert.throws(
      () =>
        store.resolveStoppedWorkByOperator(
          123,
          pending.operationId,
          "operator",
          () => 11,
        ),
      /work_resolution_preconditions_failed/,
    );
    assert.equal(
      store.readWorkOperatorResolution(123, pending.operationId),
      null,
    );
    store.write(123, original);
    store.resolveStoppedWorkByOperator(
      123,
      pending.operationId,
      "operator",
      () => 12,
    );
    assert.equal(store.read(123).workFarm.run.pending, null);
    assert.equal(store.read(123).workFarm.run.reconcileFailures, 300);
    assert.deepEqual(
      store.readWorkOperatorResolution(123, pending.operationId).checkpoint
        .pending,
      pending,
    );
    store.releaseLease("operator");
    store.close();
    const reopened = createAutomationStateStore({ directory });
    assert.equal(reopened.read(123).workFarm.run.pending, null);
    assert.deepEqual(
      reopened.readWorkOperatorResolution(123, pending.operationId).checkpoint
        .pending,
      pending,
    );
    assert.equal(
      reopened.readWorkOperatorResolution(123, pending.operationId).decision,
      "operator_accepts_unknown_outcome",
    );
    reopened.close();
  });
});

test("global raid state is encrypted, durable, and guarded by the worker lease", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    assert.equal(store.readGlobalRaids(), null);
    assert.throws(
      () => store.writeGlobalRaids({ name: "private-raid" }, "worker", 1),
      /automation_worker_unavailable/,
    );
    assert.equal(store.acquireLease("worker", 1, 1000), true);
    store.writeGlobalRaids({ name: "private-raid", count: 6 }, "worker", 2);
    assert.throws(
      () => store.writeGlobalRaids({}, "other", 2),
      /automation_worker_unavailable/,
    );
    assert.throws(
      () => store.writeGlobalRaids({}, "worker", 1001),
      /automation_worker_unavailable/,
    );
    store.close();
    assert.equal(
      readFileSync(join(directory, "automation.sqlite")).includes(
        Buffer.from("private-raid"),
      ),
      false,
    );
    const reopened = createAutomationStateStore({ directory });
    assert.deepEqual(reopened.readGlobalRaids(), {
      name: "private-raid",
      count: 6,
    });
    reopened.close();
  });
});

test("state persists across store restart using the persisted encryption key", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    await first.write(12345, {
      token: "private-token",
      nickname: "Secret Nick",
    });
    first.close();

    const second = createAutomationStateStore({ directory });
    assert.deepEqual(await second.read("12345"), {
      token: "private-token",
      nickname: "Secret Nick",
    });
    assert.deepEqual(await second.list(), [
      {
        playerId: "12345",
        value: { token: "private-token", nickname: "Secret Nick" },
      },
    ]);
    second.close();
  });
});

test("records are encrypted at rest and account ciphertext cannot be moved", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    await store.write(111, {
      token: "opaque-secret-token",
      nickname: "Private Name",
    });
    await store.write(222, { token: "other-token" });
    assert.equal(await store.read(333), null);
    store.close();

    const files = readdirSync(directory).filter((name) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(name),
    );
    for (const file of files) {
      const bytes = readFileSync(join(directory, file));
      assert.equal(bytes.includes(Buffer.from("opaque-secret-token")), false);
      assert.equal(bytes.includes(Buffer.from("Private Name")), false);
    }

    const db = new DatabaseSync(join(directory, "automation.sqlite"));
    const rows = db
      .prepare("SELECT account_key, record FROM accounts ORDER BY account_key")
      .all();
    assert.equal(rows.length, 2);
    assert.match(rows[0].account_key, /^[a-f0-9]{64}$/u);
    const accountKey = (playerId) =>
      createHmac("sha256", readFileSync(join(directory, "encryption.key")))
        .update("automation-account:")
        .update(String(playerId))
        .digest("hex");
    const source = rows.find((row) => row.account_key === accountKey(111));
    const destination = rows.find((row) => row.account_key === accountKey(222));
    db.prepare("UPDATE accounts SET record = ? WHERE account_key = ?").run(
      source.record,
      destination.account_key,
    );
    db.close();

    const isolated = createAutomationStateStore({ directory });
    assert.throws(() => isolated.read(222), /authentication_failed/u);
    isolated.close();
  });
});

test("tampered ciphertext fails closed", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    await store.write(9001, { token: "secret" });
    store.close();

    const db = new DatabaseSync(join(directory, "automation.sqlite"));
    const row = db.prepare("SELECT account_key, record FROM accounts").get();
    const envelope = JSON.parse(row.record);
    envelope.data =
      (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
    db.prepare("UPDATE accounts SET record = ? WHERE account_key = ?").run(
      JSON.stringify(envelope),
      row.account_key,
    );
    db.close();

    const restored = createAutomationStateStore({ directory });
    assert.throws(() => restored.read(9001), /authentication_failed/u);
    assert.throws(() => restored.list(), /authentication_failed/u);
    restored.close();
  });
});

test("key, database, and state directory have restrictive permissions", async () => {
  await withDirectory(async (parent) => {
    const directory = join(parent, "state");
    const store = createAutomationStateStore({ directory });
    await store.write(42, { value: true });
    store.close();
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(join(directory, "encryption.key")).mode & 0o777,
      0o600,
    );
    assert.equal(
      lstatSync(join(directory, "automation.sqlite")).mode & 0o777,
      0o600,
    );
  });
});

test("unsafe key symlinks and permissive existing key modes are rejected", () => {
  withDirectory((directory) => {
    const target = join(directory, "target.key");
    writeFileSync(target, Buffer.alloc(32));
    symlinkSync(target, join(directory, "encryption.key"));
    assert.throws(
      () => createAutomationStateStore({ directory }),
      /encryption_key_invalid/u,
    );
  });
  withDirectory((directory) => {
    writeFileSync(join(directory, "encryption.key"), Buffer.alloc(32), {
      mode: 0o644,
    });
    chmodSync(join(directory, "encryption.key"), 0o644);
    assert.throws(
      () => createAutomationStateStore({ directory }),
      /key_permissions_invalid/u,
    );
  });
});

test("player IDs and serialized record size are bounded", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    for (const playerId of [0, -1, 1.2, "0", "-1", "01", "9007199254740992"]) {
      assert.throws(() => store.read(playerId), /invalid_player_id/u);
    }
    assert.throws(
      () => store.write(1, { data: "x".repeat(4 * 1024 * 1024) }),
      /record_too_large/u,
    );
    store.close();
  });
});

test("worker lease prevents overlap and rejects stale owner release or renewal", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const second = createAutomationStateStore({ directory });
    assert.equal(first.acquireLease("worker-a", 1_000, 15_000), true);
    assert.equal(second.acquireLease("worker-b", 5_000, 15_000), false);
    assert.equal(first.acquireLease("worker-a", 5_000, 15_000), true);

    assert.equal(second.acquireLease("worker-b", 20_000, 15_000), true);
    assert.equal(first.acquireLease("worker-a", 20_001, 15_000), false);
    assert.equal(first.releaseLease("worker-a"), false);
    assert.equal(second.acquireLease("worker-b", 21_000, 15_000), true);
    assert.equal(second.releaseLease("worker-b"), true);
    assert.equal(first.releaseLease("worker-a"), false);
    first.close();
    second.close();
  });
});

test("owned account writes are fenced atomically by the live worker lease", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const second = createAutomationStateStore({ directory });
    try {
      let now = 1_000;
      assert.equal(first.acquireLease("worker-a", now, 100), true);
      first.writeOwned(101, { checkpoint: "a-current" }, "worker-a", () => now);
      assert.deepEqual(first.read(101), { checkpoint: "a-current" });

      now = 1_100;
      assert.throws(
        () =>
          first.writeOwned(
            101,
            { checkpoint: "a-expired" },
            "worker-a",
            () => now,
          ),
        /automation_worker_unavailable/u,
      );
      assert.equal(first.renewOwnedLease("worker-a", now, 100), true);
      first.writeOwned(101, { checkpoint: "a-renewed" }, "worker-a", () => now);

      now = 1_201;
      assert.equal(second.acquireLease("worker-b", now, 100), true);
      second.writeOwned(
        101,
        { checkpoint: "b-current" },
        "worker-b",
        () => now,
      );
      assert.throws(
        () =>
          first.writeOwned(
            101,
            { checkpoint: "a-late" },
            "worker-a",
            () => now,
          ),
        /automation_worker_unavailable/u,
      );
      assert.deepEqual(first.read(101), { checkpoint: "b-current" });

      now = 1_301;
      assert.equal(first.renewOwnedLease("worker-a", now, 100), false);
      assert.throws(
        () =>
          first.writeOwned(
            101,
            { checkpoint: "a-after-b-expired" },
            "worker-a",
            () => now,
          ),
        /automation_worker_unavailable/u,
      );
      assert.deepEqual(first.read(101), { checkpoint: "b-current" });
    } finally {
      first.close();
      second.close();
    }
  });
});

test("long-running series history remains durable above the old single-battle record bound", () => {
  withDirectory((directory) => {
    const store = createAutomationStateStore({ directory });
    const history = Array.from({ length: 15000 }, (_, index) => [
      `battle-${index}`,
      "won",
    ]);
    const record = {
      goalRecord: { results: history, attempts: history.map(([id]) => id) },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(record)) > 256 * 1024);
    try {
      store.write(1, record);
      assert.equal(store.read(1).goalRecord.results.length, 15000);
    } finally {
      store.close();
    }
  });
});
