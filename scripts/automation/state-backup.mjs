import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createAutomationStateStore } from "./state-store.mjs";

const MAGIC = Buffer.from("MHASTA01", "ascii");
const MAX_MANIFEST_BYTES = 4096;
const MAX_DATABASE_BYTES = 8 * 1024 * 1024 * 1024;
const KEY_FILE = "encryption.key";
const DATABASE_FILE = "automation.sqlite";
const RESTORE_MARKER = "restore-required";

function fail() {
  throw new Error("automation_state_archive_invalid");
}

function assertRegularFile(
  path,
  { privateMode = false, minimumSize = 1 } = {},
) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < minimumSize ||
    (privateMode && (stat.mode & 0o077) !== 0)
  )
    fail();
  return stat;
}

function readPrivateKey(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const pathStat = lstatSync(path);
    if (
      !stat.isFile() ||
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      stat.size !== 32 ||
      (stat.mode & 0o077) !== 0
    )
      fail();
    const key = readFileSync(fd);
    if (key.byteLength !== 32) fail();
    return key;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function quoteSqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function inspectDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    const result = database.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") fail();
  } finally {
    database.close();
  }
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.byteLength)
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset);
}

async function createSnapshot(directory, temporaryDirectory) {
  const root = resolve(directory);
  const rootStat = lstatSync(root);
  const temporaryRoot = resolve(temporaryDirectory);
  const temporaryStat = lstatSync(temporaryRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    (rootStat.mode & 0o077) !== 0 ||
    !temporaryStat.isDirectory() ||
    temporaryStat.isSymbolicLink() ||
    (temporaryStat.mode & 0o077) !== 0
  )
    fail();
  const keyPath = join(root, KEY_FILE);
  const databasePath = join(root, DATABASE_FILE);
  assertRegularFile(keyPath, { privateMode: true, minimumSize: 32 });
  const keyProbe = readPrivateKey(keyPath);
  const validKey = keyProbe.byteLength === 32;
  keyProbe.fill(0);
  if (!validKey) fail();
  assertRegularFile(databasePath, { privateMode: true });
  for (const suffix of ["-wal", "-shm"]) {
    try {
      assertRegularFile(databasePath + suffix, {
        privateMode: true,
        minimumSize: 0,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const staging = mkdtempSync(
    join(temporaryRoot, "madhouse-automation-backup-"),
  );
  chmodSync(staging, 0o700);
  const snapshotPath = join(staging, DATABASE_FILE);
  let source;
  try {
    source = new DatabaseSync(databasePath, { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000;");
    const result = source.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") fail();
    source.exec(`VACUUM INTO ${quoteSqlString(snapshotPath)};`);
    source?.close();
    source = null;
    assertRegularFile(snapshotPath);
    chmodSync(snapshotPath, 0o600);
    inspectDatabase(snapshotPath);
    return { staging, keyPath, snapshotPath };
  } catch (error) {
    source?.close();
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function writeAutomationStateArchive({
  directory,
  temporaryDirectory,
  output,
} = {}) {
  if (
    typeof directory !== "string" ||
    !directory ||
    typeof temporaryDirectory !== "string" ||
    !temporaryDirectory ||
    !output?.write
  )
    throw new TypeError("automation_state_archive_arguments_invalid");
  const snapshot = await createSnapshot(directory, temporaryDirectory);
  let key;
  try {
    key = readPrivateKey(snapshot.keyPath);
    const databaseBytes = assertRegularFile(snapshot.snapshotPath).size;
    const manifest = Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        keyBytes: key.byteLength,
        databaseBytes,
        keySha256: createHash("sha256").update(key).digest("hex"),
        databaseSha256: await hashFile(snapshot.snapshotPath),
      }),
      "utf8",
    );
    if (manifest.byteLength > MAX_MANIFEST_BYTES) fail();
    const manifestLength = Buffer.alloc(4);
    manifestLength.writeUInt32BE(manifest.byteLength);
    async function* archive() {
      yield MAGIC;
      yield manifestLength;
      yield manifest;
      yield key;
      for await (const chunk of createReadStream(snapshot.snapshotPath))
        yield chunk;
    }
    await pipeline(Readable.from(archive()), output);
  } finally {
    key?.fill(0);
    rmSync(snapshot.staging, { recursive: true, force: true });
  }
}

class ArchiveReader {
  constructor(input) {
    this.iterator = input[Symbol.asyncIterator]();
    this.pending = Buffer.alloc(0);
  }

  async readExact(length) {
    while (this.pending.byteLength < length) {
      const next = await this.iterator.next();
      if (next.done) fail();
      const chunk = Buffer.from(next.value);
      if (!chunk.byteLength) continue;
      this.pending = this.pending.length
        ? Buffer.concat([this.pending, chunk])
        : chunk;
    }
    const result = this.pending.subarray(0, length);
    this.pending = this.pending.subarray(length);
    return result;
  }

  async copyExact(length, destination) {
    const fd = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const digest = createHash("sha256");
    try {
      let remaining = length;
      while (remaining > 0) {
        const chunk = await this.readExact(Math.min(remaining, 64 * 1024));
        writeAll(fd, chunk);
        digest.update(chunk);
        remaining -= chunk.byteLength;
      }
      fsyncSync(fd);
      return digest.digest("hex");
    } finally {
      closeSync(fd);
    }
  }

  async assertEnd() {
    if (this.pending.byteLength) fail();
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (next.value?.byteLength) fail();
    }
  }
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail();
  }
  const keys = [
    "version",
    "createdAt",
    "keyBytes",
    "databaseBytes",
    "keySha256",
    "databaseSha256",
  ];
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Object.keys(manifest).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(manifest, key)) ||
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.createdAt) ||
    manifest.createdAt < 1 ||
    manifest.keyBytes !== 32 ||
    !Number.isSafeInteger(manifest.databaseBytes) ||
    manifest.databaseBytes < 1 ||
    manifest.databaseBytes > MAX_DATABASE_BYTES ||
    !/^[0-9a-f]{64}$/u.test(manifest.keySha256) ||
    !/^[0-9a-f]{64}$/u.test(manifest.databaseSha256)
  )
    fail();
  return manifest;
}

function createRestoreMarker(path) {
  const createdAt = Date.now();
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify({ schemaVersion: 1, createdAt })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return createdAt;
}

function prepareTarget(directory) {
  const target = resolve(directory);
  if (target === "/" || target === tmpdir() || basename(target).length === 0)
    fail();
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  if (readdirSync(target).length !== 0) fail();
  chmodSync(target, 0o700);
  const markerCreatedAt = createRestoreMarker(join(target, RESTORE_MARKER));
  return { target, markerCreatedAt };
}

export async function restoreAutomationStateArchive({ input, directory } = {}) {
  if (
    !input?.[Symbol.asyncIterator] ||
    typeof directory !== "string" ||
    !directory
  )
    throw new TypeError("automation_state_archive_arguments_invalid");
  const { target, markerCreatedAt } = prepareTarget(directory);
  const staging = mkdtempSync(join(target, ".restore-"));
  chmodSync(staging, 0o700);
  let store;
  try {
    const reader = new ArchiveReader(input);
    if (!(await reader.readExact(MAGIC.byteLength)).equals(MAGIC)) fail();
    const manifestLength = (await reader.readExact(4)).readUInt32BE();
    if (manifestLength < 2 || manifestLength > MAX_MANIFEST_BYTES) fail();
    const manifest = parseManifest(await reader.readExact(manifestLength));
    const keyPath = join(staging, KEY_FILE);
    const databasePath = join(staging, DATABASE_FILE);
    const keyHash = await reader.copyExact(manifest.keyBytes, keyPath);
    const databaseHash = await reader.copyExact(
      manifest.databaseBytes,
      databasePath,
    );
    await reader.assertEnd();
    if (
      keyHash !== manifest.keySha256 ||
      databaseHash !== manifest.databaseSha256
    )
      fail();
    inspectDatabase(databasePath);

    renameSync(keyPath, join(target, KEY_FILE));
    renameSync(databasePath, join(target, DATABASE_FILE));
    store = createAutomationStateStore({ directory: target });
    store.list();
    store.readSnapshots();
    store.prepareRestoredSnapshot({ activatedAt: markerCreatedAt });
    if (!store.isRestoreGuardActive()) fail();
    store.close();
    store = null;
    return {
      createdAt: manifest.createdAt,
      databaseBytes: manifest.databaseBytes,
    };
  } catch {
    store?.close();
    throw new Error("automation_state_restore_failed");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
