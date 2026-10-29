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

const BRIDGE_ATTEMPT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BRIDGE_OPERATION_ID = /^[A-Za-z0-9_-]{8,120}$/;
const BRIDGE_ATTEMPT_PHASES = new Set([
  "prepared",
  "dispatched",
  "uncertain",
  "completed",
  "rejected",
]);
const BRIDGE_ATTEMPT_ACTIVE = new Set(["prepared", "dispatched", "uncertain"]);
const BRIDGE_PHASE_TRANSITIONS = {
  prepared: new Set(["dispatched", "uncertain", "rejected"]),
  dispatched: new Set(["uncertain", "completed", "rejected"]),
  uncertain: new Set(["completed", "rejected"]),
  completed: new Set(),
  rejected: new Set(),
};

function validateBridgeAttempt(attempt) {
  const required = [
    "action",
    "bindingRevision",
    "createdAt",
    "deviceGeneration",
    "deviceId",
    "id",
    "operationId",
    "phase",
    "playerId",
    "updatedAt",
  ];
  const optional = ["checkpointOperationId", "transportStoppedAt"];
  if (
    !attempt ||
    typeof attempt !== "object" ||
    Array.isArray(attempt) ||
    required.some((key) => !Object.hasOwn(attempt, key)) ||
    Object.keys(attempt).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    throw new TypeError("invalid_bridge_attempt");
  const playerId = normalizePlayerId(attempt.playerId);
  if (
    !BRIDGE_ATTEMPT_ID.test(attempt.id) ||
    !BRIDGE_OPERATION_ID.test(attempt.operationId) ||
    (Object.hasOwn(attempt, "checkpointOperationId") &&
      !BRIDGE_OPERATION_ID.test(attempt.checkpointOperationId)) ||
    (Object.hasOwn(attempt, "transportStoppedAt") &&
      (!Number.isSafeInteger(attempt.transportStoppedAt) ||
        attempt.transportStoppedAt < attempt.createdAt ||
        attempt.transportStoppedAt > attempt.updatedAt)) ||
    !BRIDGE_ATTEMPT_ID.test(attempt.deviceId) ||
    !Number.isSafeInteger(attempt.bindingRevision) ||
    attempt.bindingRevision < 1 ||
    !Number.isSafeInteger(attempt.deviceGeneration) ||
    attempt.deviceGeneration < 1 ||
    typeof attempt.action !== "string" ||
    !/^[a-z][a-z0-9._-]{0,63}$/.test(attempt.action) ||
    !BRIDGE_ATTEMPT_PHASES.has(attempt.phase) ||
    !Number.isSafeInteger(attempt.createdAt) ||
    attempt.createdAt < 0 ||
    !Number.isSafeInteger(attempt.updatedAt) ||
    attempt.updatedAt < attempt.createdAt
  )
    throw new TypeError("invalid_bridge_attempt");
  return { ...attempt, playerId };
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
    CREATE TABLE IF NOT EXISTS bridge_attempts (
      attempt_key TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      record TEXT NOT NULL
    ) WITHOUT ROWID;
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
  const insertBridgeAttempt = db.prepare(
    "INSERT INTO bridge_attempts (attempt_key, revision, record) VALUES (?, 1, ?)",
  );
  const selectBridgeAttempt = db.prepare(
    "SELECT revision, record FROM bridge_attempts WHERE attempt_key = ?",
  );
  const selectBridgeAttempts = db.prepare(
    "SELECT attempt_key, revision, record FROM bridge_attempts",
  );
  const updateBridgeAttempt = db.prepare(
    "UPDATE bridge_attempts SET revision = ?, record = ? WHERE attempt_key = ? AND revision = ?",
  );
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
    createBridgeAttempt(attempt) {
      if (Object.hasOwn(attempt || {}, "transportStoppedAt"))
        throw new TypeError("invalid_bridge_attempt");
      const value = validateBridgeAttempt(attempt);
      const attemptKey = createHmac("sha256", key)
        .update("automation-bridge-attempt:")
        .update(value.id)
        .digest("hex");
      const record = { ...value, revision: 1 };
      const encrypted = encrypt(key, attemptKey, record);
      transaction(() => insertBridgeAttempt.run(attemptKey, encrypted));
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(databasePath + suffix))
          chmodSync(databasePath + suffix, 0o600);
      return record;
    },
    readActiveBridgeAttempts() {
      return selectBridgeAttempts
        .all()
        .map((row) => {
          const record = decrypt(key, row.attempt_key, row.record);
          if (
            !record ||
            record.revision !== row.revision ||
            !BRIDGE_ATTEMPT_ID.test(record.id || "") ||
            createHmac("sha256", key)
              .update("automation-bridge-attempt:")
              .update(record.id)
              .digest("hex") !== row.attempt_key
          )
            throw new Error("bridge_attempt_corrupt");
          const value = validateBridgeAttempt({
            id: record.id,
            playerId: record.playerId,
            operationId: record.operationId,
            ...(Object.hasOwn(record, "checkpointOperationId")
              ? { checkpointOperationId: record.checkpointOperationId }
              : {}),
            ...(Object.hasOwn(record, "transportStoppedAt")
              ? { transportStoppedAt: record.transportStoppedAt }
              : {}),
            deviceId: record.deviceId,
            bindingRevision: record.bindingRevision,
            deviceGeneration: record.deviceGeneration,
            action: record.action,
            phase: record.phase,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          });
          return { ...value, revision: row.revision };
        })
        .filter((record) => BRIDGE_ATTEMPT_ACTIVE.has(record.phase));
    },
    compareAndSetBridgeAttempt(id, expectedRevision, updates) {
      if (
        !BRIDGE_ATTEMPT_ID.test(id || "") ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        !updates ||
        typeof updates !== "object" ||
        Array.isArray(updates) ||
        Object.keys(updates).sort().join(",") !== "phase,updatedAt" ||
        !BRIDGE_ATTEMPT_PHASES.has(updates.phase) ||
        !Number.isSafeInteger(updates.updatedAt) ||
        updates.updatedAt < 0
      )
        throw new TypeError("invalid_bridge_attempt_update");
      const attemptKey = createHmac("sha256", key)
        .update("automation-bridge-attempt:")
        .update(id)
        .digest("hex");
      return transaction(() => {
        const current = selectBridgeAttempt.get(attemptKey);
        if (!current || current.revision !== expectedRevision) return null;
        const record = decrypt(key, attemptKey, current.record);
        if (!record || record.id !== id || record.revision !== expectedRevision)
          throw new Error("bridge_attempt_corrupt");
        const validated = validateBridgeAttempt({
          id: record.id,
          playerId: record.playerId,
          operationId: record.operationId,
          ...(Object.hasOwn(record, "checkpointOperationId")
            ? { checkpointOperationId: record.checkpointOperationId }
            : {}),
          ...(Object.hasOwn(record, "transportStoppedAt")
            ? { transportStoppedAt: record.transportStoppedAt }
            : {}),
          deviceId: record.deviceId,
          bindingRevision: record.bindingRevision,
          deviceGeneration: record.deviceGeneration,
          action: record.action,
          phase: record.phase,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
        if (
          !BRIDGE_PHASE_TRANSITIONS[validated.phase].has(updates.phase) ||
          updates.updatedAt < validated.updatedAt
        )
          throw new TypeError("invalid_bridge_attempt_transition");
        const next = {
          ...validated,
          phase: updates.phase,
          updatedAt: updates.updatedAt,
          revision: expectedRevision + 1,
        };
        const encrypted = encrypt(key, attemptKey, next);
        const result = updateBridgeAttempt.run(
          next.revision,
          encrypted,
          attemptKey,
          expectedRevision,
        );
        return result.changes === 1 ? next : null;
      });
    },
    confirmBridgeTransportStop(id, expectedRevision, nowMs) {
      if (
        !BRIDGE_ATTEMPT_ID.test(id || "") ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        !Number.isSafeInteger(nowMs) ||
        nowMs < 0
      )
        throw new TypeError("invalid_bridge_transport_stop");
      const attemptKey = createHmac("sha256", key)
        .update("automation-bridge-attempt:")
        .update(id)
        .digest("hex");
      return transaction(() => {
        const row = selectBridgeAttempt.get(attemptKey);
        if (!row || row.revision !== expectedRevision) return null;
        const record = decrypt(key, attemptKey, row.record);
        if (!record || record.id !== id || record.revision !== row.revision)
          throw new Error("bridge_attempt_corrupt");
        const { revision, ...value } = record;
        const validated = validateBridgeAttempt(value);
        if (
          !["dispatched", "uncertain"].includes(validated.phase) ||
          Object.hasOwn(validated, "transportStoppedAt") ||
          nowMs < validated.updatedAt
        )
          throw new TypeError("invalid_bridge_transport_stop");
        const next = {
          ...validated,
          updatedAt: nowMs,
          transportStoppedAt: nowMs,
          revision: revision + 1,
        };
        const result = updateBridgeAttempt.run(
          next.revision,
          encrypt(key, attemptKey, next),
          attemptKey,
          expectedRevision,
        );
        return result.changes === 1 ? next : null;
      });
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
