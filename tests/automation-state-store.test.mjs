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
