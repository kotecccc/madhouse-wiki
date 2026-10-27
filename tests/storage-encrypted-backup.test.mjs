import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(
  new URL("../scripts/storage/backup-encrypted.sh", import.meta.url),
);
test("offline encrypted storage backup requires confirmation and removes partial output on failure", () => {
  const root = mkdtempSync(join(tmpdir(), "storage-encrypted-backup-"));
  try {
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "backups"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "data", "fixture"), "synthetic-private-data");
    const age = join(root, "bin", "age");
    const env = {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      MADHOUSE_STORAGE_BACKUP_ROOT: root,
      MADHOUSE_STORAGE_BACKUP_RECIPIENT: "fixture-recipient",
    };
    writeFileSync(
      age,
      "#!/bin/sh\ncat >/dev/null\nprintf 'partial'\nexit 1\n",
      { mode: 0o755 },
    );
    const denied = spawnSync("bash", [script], { env, encoding: "utf8" });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /storage_backup_offline_confirmation_required/);
    assert.deepEqual(readdirSync(join(root, "backups")), []);
    const failed = spawnSync("bash", [script], {
      env: { ...env, MADHOUSE_STORAGE_OFFLINE_CONFIRMED: "1" },
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(readdirSync(join(root, "backups")), []);
    // This fake tests pipe/cleanup behavior, not age cryptography.
    writeFileSync(age, "#!/bin/sh\nbase64\n", { mode: 0o755 });
    const success = spawnSync("bash", [script], {
      env: { ...env, MADHOUSE_STORAGE_OFFLINE_CONFIRMED: "1" },
      encoding: "utf8",
    });
    assert.equal(success.status, 0, success.stderr);
    const archive = success.stdout.trim();
    assert.equal(readdirSync(join(root, "backups")).length, 1);
    assert.equal(statSync(archive).mode & 0o077, 0);
    assert.ok(readFileSync(archive).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
