import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createOwnerGameSessionResolver } from "../scripts/account/owner-session.mjs";
import {
  restoreAutomationStateArchive,
  writeAutomationStateArchive,
} from "../scripts/automation/state-backup.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

async function withDirectories(run) {
  const root = mkdtempSync(join(tmpdir(), "automation-state-backup-test-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const scratch = join(root, "scratch");
  for (const directory of [source, target, scratch])
    mkdirSync(directory, { mode: 0o700 });
  try {
    return await run({ root, source, target, scratch });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function archiveWriter(chunks) {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
}

test("online SQLite snapshot restores the committed WAL state behind a reauthorization gate", async () => {
  await withDirectories(async ({ source, target, scratch }) => {
    const live = createAutomationStateStore({ directory: source });
    live.bindVerifiedGameAccount("54321", "101", 100);
    live.selectRoutePolicy("101", {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: 101,
    });
    live.write("101", {
      credential: "Bearer fixture.token.signature",
      nickname: "Synthetic fixture",
      auto: { enabled: true, phase: "between_battles" },
      assistant: { pending: null },
    });
    live.writeSnapshot("101", {
      schemaVersion: 1,
      playerId: "101",
      sections: { "/api/me": { updatedAt: 101, data: { playerId: 101 } } },
      credentialHashes: [],
    });
    live.activateRestoreGuard({ activatedAt: 50 });
    live.bindVerifiedGameAccount("54321", "101", 51);
    live.confirmRestoredAccount({
      ownerId: "54321",
      playerId: "101",
      verifiedAt: 52,
    });
    live.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 53,
    });
    assert.equal(live.isRestoreRequired("101"), false);
    const now = Date.parse("2026-10-27T12:00:00Z");
    const botToken = "123456:restore-test-token";
    const proof = new URLSearchParams({
      auth_date: String(now / 1000),
      user: JSON.stringify({ id: 54321 }),
    });
    const dataCheck = [...proof.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
    proof.set(
      "hash",
      createHmac("sha256", secret).update(dataCheck).digest("hex"),
    );
    const credential = {
      ownerId: "54321",
      playerId: "101",
      accessToken: "fixture.token.signature",
      credentialVersion: 1,
      routeEpoch: live.readRoutePolicy("101").routeEpoch,
      expiresAt: now + 60_000,
      revoked: false,
    };
    const resolverFor = (store) =>
      createOwnerGameSessionResolver({
        store,
        credentialStore: { read: async () => ({ record: credential }) },
        botToken,
        now: () => now,
      });
    assert.equal(
      (await resolverFor(live)(proof.toString())).authorization,
      "Bearer fixture.token.signature",
    );
    assert.ok(lstatSync(join(source, "automation.sqlite-wal")).size > 0);

    const chunks = [];
    await writeAutomationStateArchive({
      directory: source,
      temporaryDirectory: scratch,
      output: archiveWriter(chunks),
    });
    const archive = Buffer.concat(chunks);

    // This committed WAL write happens after the snapshot and must not leak into it.
    live.write("101", {
      credential: "Bearer fixture.token.signature",
      nickname: "Later synthetic fixture",
      auto: { enabled: false, phase: "stopped" },
      assistant: { pending: null },
    });
    live.close();

    const result = await restoreAutomationStateArchive({
      input: Readable.from([archive]),
      directory: target,
    });
    assert.ok(result.databaseBytes > 0);
    assert.ok(
      ["automation.sqlite", "encryption.key", "restore-required"].every(
        (name) => readdirSync(target).includes(name),
      ),
    );
    assert.equal(lstatSync(join(target, "encryption.key")).mode & 0o077, 0);
    assert.equal(
      JSON.parse(readFileSync(join(target, "restore-required"), "utf8"))
        .schemaVersion,
      1,
    );

    const restored = createAutomationStateStore({ directory: target });
    assert.equal(restored.isRestoreGuardActive(), true);
    assert.equal(restored.isRestoreRequired("101"), true);
    assert.equal(restored.read("101").nickname, "Synthetic fixture");
    assert.equal(restored.readGameAccountOwner("101"), null);
    await assert.rejects(resolverFor(restored)(proof.toString()), {
      code: "game_session_required",
      status: 401,
    });
    assert.equal(restored.readRoutePolicy("101").policy, "direct");
    assert.equal(
      restored.readSnapshots()[0].sections["/api/me"].data.playerId,
      101,
    );
    restored.close();
  });
});

test("tampered state archive fails closed and leaves the target restore marker", async () => {
  await withDirectories(async ({ source, target, scratch }) => {
    const live = createAutomationStateStore({ directory: source });
    live.write("101", { credential: "Bearer fixture.token.signature" });
    live.close();
    const chunks = [];
    await writeAutomationStateArchive({
      directory: source,
      temporaryDirectory: scratch,
      output: archiveWriter(chunks),
    });
    const archive = Buffer.concat(chunks);
    archive[archive.length - 1] ^= 1;

    await assert.rejects(
      () =>
        restoreAutomationStateArchive({
          input: Readable.from([archive]),
          directory: target,
        }),
      /automation_state_restore_failed/u,
    );
    assert.equal(lstatSync(join(target, "restore-required")).isFile(), true);
    assert.equal(existsSync(join(target, "automation.sqlite")), false);
  });
});

test("backup CLI refuses to write an unencrypted archive to a regular file", async () => {
  await withDirectories(async ({ root, source, scratch }) => {
    const outputPath = join(root, "raw-backup.bin");
    writeFileSync(outputPath, "");
    const outputFd = openSync(outputPath, "w");
    let result;
    try {
      result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../scripts/automation/backup-state.mjs", import.meta.url),
          ),
        ],
        {
          env: {
            ...process.env,
            MADHOUSE_AUTOMATION_STATE_DIR: source,
            MADHOUSE_AUTOMATION_SNAPSHOT_TMPDIR: scratch,
          },
          stdio: ["ignore", outputFd, "pipe"],
        },
      );
    } finally {
      closeSync(outputFd);
    }

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.toString("utf8").trim(),
      "automation_backup_requires_encrypted_pipe",
    );
    assert.equal(readFileSync(outputPath).byteLength, 0);
  });
});
