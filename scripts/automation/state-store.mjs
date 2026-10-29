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

function validGameOutage(state) {
  return (
    state &&
    typeof state === "object" &&
    !Array.isArray(state) &&
    Object.keys(state).sort().join(",") === "evidence,failures,readyAt" &&
    Number.isSafeInteger(state.readyAt) &&
    state.readyAt >= 0 &&
    Number.isSafeInteger(state.failures) &&
    state.failures >= 0 &&
    Array.isArray(state.evidence) &&
    state.evidence.length <= 1 &&
    state.evidence.every(
      (item) =>
        item &&
        Object.keys(item).sort().join(",") === "at,id,retryAt" &&
        /^[0-9a-f]{64}$/.test(item.id) &&
        Number.isSafeInteger(item.at) &&
        item.at >= 0 &&
        Number.isSafeInteger(item.retryAt) &&
        item.retryAt >= item.at,
    ) &&
    (state.readyAt === 0
      ? state.failures === 0
      : state.failures > 0 && state.evidence.length === 0)
  );
}

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
    CREATE TABLE IF NOT EXISTS account_snapshots (
      account_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS worker_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_cooldown (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      ready_at INTEGER NOT NULL,
      failures INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_outage (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_raids (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      record TEXT NOT NULL
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
  const snapshotSelect = db.prepare(
    "SELECT record FROM account_snapshots WHERE account_key = ?",
  );
  const snapshotUpsert = db.prepare(
    "INSERT INTO account_snapshots (account_key, record) VALUES (?, ?) ON CONFLICT(account_key) DO UPDATE SET record = excluded.record",
  );
  const snapshotAll = db.prepare(
    "SELECT account_key, record FROM account_snapshots",
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
  const selectCooldown = db.prepare(
    "SELECT ready_at, failures FROM queue_cooldown WHERE singleton = 1",
  );
  const selectLease = db.prepare(
    "SELECT owner, expires_at FROM worker_lease WHERE singleton = 1",
  );
  const selectGameOutage = db.prepare(
    "SELECT record FROM game_outage WHERE singleton = 1",
  );
  const selectGlobalRaids = db.prepare(
    "SELECT record FROM global_raids WHERE singleton = 1",
  );
  const saveGlobalRaids = db.prepare(
    "INSERT INTO global_raids (singleton, record) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET record = excluded.record",
  );
  const saveGameOutage =
    db.prepare(`INSERT INTO game_outage (singleton, record) VALUES (1, ?)
    ON CONFLICT(singleton) DO UPDATE SET record = excluded.record`);
  const saveCooldown =
    db.prepare(`INSERT INTO queue_cooldown (singleton, ready_at, failures) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET ready_at = excluded.ready_at, failures = excluded.failures`);

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
    readGlobalRaids() {
      const row = selectGlobalRaids.get();
      return row ? decrypt(key, "global-raids", row.record) : null;
    },
    writeGlobalRaids(value, worker, now) {
      const record = encrypt(key, "global-raids", value);
      transaction(() => {
        const lease = selectLease.get();
        if (!lease || lease.owner !== worker || lease.expires_at <= now)
          throw new Error("automation_worker_unavailable");
        saveGlobalRaids.run(record);
      });
    },
    readSnapshots() {
      return snapshotAll
        .all()
        .map((row) => decrypt(key, row.account_key, row.record));
    },
    readSnapshot(playerId) {
      const id = opaqueId(key, normalizePlayerId(playerId));
      const row = snapshotSelect.get(id);
      return row ? decrypt(key, id, row.record) : null;
    },
    writeSnapshot(playerId, value) {
      const normalized = normalizePlayerId(playerId);
      const id = opaqueId(key, normalized);
      const encrypted = encrypt(key, id, { ...value, playerId: normalized });
      transaction(() => snapshotUpsert.run(id, encrypted));
    },
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
    getQueueCooldown() {
      const row = selectCooldown.get();
      return row
        ? { readyAt: row.ready_at, failures: row.failures }
        : { readyAt: 0, failures: 0 };
    },
    getGameOutage() {
      const row = selectGameOutage.get();
      if (!row) return { evidence: [], readyAt: 0, failures: 0 };
      let state;
      try {
        state = JSON.parse(row.record);
      } catch {
        throw new Error("game_outage_state_corrupt");
      }
      if (!validGameOutage(state)) throw new Error("game_outage_state_corrupt");
      return state;
    },
    setGameOutage(state, owner, nowMs) {
      if (
        !validGameOutage(state) ||
        typeof owner !== "string" ||
        !owner ||
        !Number.isSafeInteger(nowMs)
      )
        throw new TypeError("invalid_game_outage");
      transaction(() => {
        const lease = selectLease.get();
        if (!lease || lease.owner !== owner || lease.expires_at <= nowMs)
          throw new Error("automation_worker_unavailable");
        saveGameOutage.run(JSON.stringify(state));
      });
    },
    setQueueCooldown(readyAt, failures, owner, nowMs) {
      if (
        !Number.isSafeInteger(readyAt) ||
        readyAt < 0 ||
        !Number.isSafeInteger(failures) ||
        failures < 0 ||
        typeof owner !== "string" ||
        !owner ||
        !Number.isSafeInteger(nowMs)
      )
        throw new TypeError("invalid_queue_cooldown");
      transaction(() => {
        const lease = selectLease.get();
        if (!lease || lease.owner !== owner || lease.expires_at <= nowMs)
          throw new Error("automation_worker_unavailable");
        saveCooldown.run(readyAt, failures);
      });
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
