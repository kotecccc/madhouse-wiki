import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

// Goal series retain per-battle deduplication history across long runs.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const KEY_FILE = "encryption.key";
const DATABASE_FILE = "automation.sqlite";
const encoder = new TextEncoder();

function ensureDirectory(directory) {
  const absolute = resolve(directory);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("automation_state_directory_invalid");
  chmodSync(absolute, 0o700);
  return absolute;
}

function loadOrCreateKey(directory) {
  const path = join(directory, KEY_FILE);
  try {
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const key = randomBytes(32);
      writeFileSync(fd, key);
      fsyncSync(fd);
      return key;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const pathStat = lstatSync(path);
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink())
      throw new Error("automation_encryption_key_invalid");
    if ((stat.mode & 0o077) !== 0)
      throw new Error("automation_encryption_key_permissions_invalid");
    const key = readFileSync(fd);
    if (key.byteLength !== 32)
      throw new Error("automation_encryption_key_invalid");
    return key;
  } catch (error) {
    if (error.code === "ELOOP")
      throw new Error("automation_encryption_key_invalid", { cause: error });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizePlayerId(playerId) {
  if (
    !(typeof playerId === "number" && Number.isSafeInteger(playerId)) &&
    !(typeof playerId === "string" && /^[1-9]\d{0,15}$/u.test(playerId))
  )
    throw new TypeError("invalid_player_id");
  const normalized = String(playerId);
  if (
    !/^[1-9]\d{0,15}$/u.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw new TypeError("invalid_player_id");
  return normalized;
}

function opaqueId(key, playerId) {
  return createHmac("sha256", key)
    .update("automation-account:")
    .update(playerId)
    .digest("hex");
}

function encrypt(key, id, record) {
  const plaintext = Buffer.from(JSON.stringify(record));
  if (plaintext.byteLength > MAX_RECORD_BYTES)
    throw new RangeError("automation_record_too_large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encoder.encode(id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64url"),
    data: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

function decrypt(key, id, envelopeText) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new Error("automation_state_corrupt");
  }
  if (
    envelope?.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.data !== "string" ||
    typeof envelope.tag !== "string"
  )
    throw new Error("automation_state_corrupt");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(encoder.encode(id));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_RECORD_BYTES)
      throw new Error("automation_state_corrupt");
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("automation_state_authentication_failed");
  }
}

export function createAutomationStateStore({ directory }) {
  if (typeof directory !== "string" || !directory)
    throw new TypeError("automation_state_directory_required");
  const root = ensureDirectory(directory);
  const key = loadOrCreateKey(root);
  const databasePath = join(root, DATABASE_FILE);
  if (!existsSync(databasePath)) {
    let fd;
    try {
      fd = openSync(
        databasePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("automation_state_database_invalid");
  }

  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS worker_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = databasePath + suffix;
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }

  const select = db.prepare(
    "SELECT record FROM accounts WHERE account_key = ?",
  );
  const upsert = db.prepare(
    "INSERT INTO accounts (account_key, record) VALUES (?, ?) ON CONFLICT(account_key) DO UPDATE SET record = excluded.record",
  );
  const selectAll = db.prepare(
    "SELECT account_key, record FROM accounts ORDER BY account_key",
  );
  const acquireLeaseStatement = db.prepare(`
    INSERT INTO worker_lease (singleton, owner, expires_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE
    SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE worker_lease.owner = excluded.owner OR worker_lease.expires_at <= ?
  `);
  const releaseLeaseStatement = db.prepare(
    "DELETE FROM worker_lease WHERE singleton = 1 AND owner = ?",
  );

  function transaction(run) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  return {
    read(playerId) {
      const normalized = normalizePlayerId(playerId);
      const id = opaqueId(key, normalized);
      const row = select.get(id);
      if (!row) return null;
      const record = decrypt(key, id, row.record);
      if (
        !record ||
        record.playerId !== normalized ||
        !Object.hasOwn(record, "value")
      )
        throw new Error("automation_state_corrupt");
      return record.value;
    },
    write(playerId, value) {
      const normalized = normalizePlayerId(playerId);
      let record;
      try {
        record = JSON.stringify({ playerId: normalized, value });
      } catch {
        throw new TypeError("automation_record_invalid");
      }
      if (Buffer.byteLength(record) > MAX_RECORD_BYTES)
        throw new RangeError("automation_record_too_large");
      const id = opaqueId(key, normalized);
      const encrypted = encrypt(key, id, {
        playerId: normalized,
        value: JSON.parse(record).value,
      });
      transaction(() => upsert.run(id, encrypted));
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(databasePath + suffix))
          chmodSync(databasePath + suffix, 0o600);
    },
    list() {
      const rows = selectAll.all();
      const result = [];
      for (const row of rows) {
        const record = decrypt(key, row.account_key, row.record);
        if (
          !record ||
          typeof record.playerId !== "string" ||
          opaqueId(key, record.playerId) !== row.account_key ||
          !Object.hasOwn(record, "value")
        )
          throw new Error("automation_state_corrupt");
        result.push({ playerId: record.playerId, value: record.value });
      }
      return result;
    },
    acquireLease(owner, nowMs, ttlMs) {
      if (
        typeof owner !== "string" ||
        owner.length < 1 ||
        owner.length > 256 ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs <= 0 ||
        !Number.isSafeInteger(nowMs + ttlMs)
      )
        throw new TypeError("invalid_automation_lease");
      const result = transaction(() =>
        acquireLeaseStatement.run(owner, nowMs + ttlMs, nowMs),
      );
      return result.changes === 1;
    },
    releaseLease(owner) {
      if (typeof owner !== "string" || owner.length < 1 || owner.length > 256)
        throw new TypeError("invalid_automation_lease_owner");
      const result = transaction(() => releaseLeaseStatement.run(owner));
      return result.changes === 1;
    },
    close() {
      db.close();
    },
  };
}
