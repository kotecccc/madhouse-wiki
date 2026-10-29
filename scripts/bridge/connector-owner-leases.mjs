import { randomUUID } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Cross-process fence for the legacy Connector's direct game requests. The
 * owner must already be authenticated by a trusted connector boundary. Leases
 * do not expire: a lost response requires explicit reconciliation.
 */
export function createConnectorOwnerLeases({
  db,
  registry,
  routeWitness = null,
} = {}) {
  if (!db || typeof registry?.ownerKey !== "function")
    throw new TypeError("owner_lease_dependencies_required");
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const validDigest = (value) => /^[a-f0-9]{64}$/.test(value || "");
  const retryableProfileStatuses = new Set([500, 502, 503, 504]);
  // Rows without a step record are legacy leases and intentionally fail closed.
  function stepAllowed(ownerKey, leaseId, step, attempt, credentialDigest) {
    if (
      !["telegram_auth", "profile"].includes(step) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 3 ||
      (credentialDigest != null && !validDigest(credentialDigest))
    )
      return false;
    const row = db
      .prepare(
        `SELECT l.phase, l.operation, s.stage, s.attempt, s.credential_digest,
                s.last_status
           FROM mobile_bridge_owner_leases l
           JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
          WHERE l.owner_key = ? AND l.lease_id = ?`,
      )
      .get(ownerKey, leaseId);
    if (!row || row.phase !== "dispatched") return false;
    if (step === "telegram_auth")
      return (
        row.operation === "telegram_auth" &&
        row.stage === "auth_ready" &&
        row.attempt === 0 &&
        attempt === 1 &&
        credentialDigest == null
      );
    if (row.operation === "session_verify") {
      if (
        attempt === 1 &&
        row.stage === "profile_ready" &&
        row.attempt === 0 &&
        row.credential_digest == null
      )
        return validDigest(credentialDigest);
    } else if (
      row.operation === "telegram_auth" &&
      row.stage === "profile_ready" &&
      row.attempt === 0 &&
      row.credential_digest === credentialDigest &&
      validDigest(row.credential_digest)
    ) {
      return attempt === 1;
    } else if (row.operation !== "telegram_auth") {
      return false;
    }
    if (credentialDigest !== row.credential_digest) return false;
    return (
      row.stage === "profile_retry_ready" &&
      row.attempt < 3 &&
      attempt === row.attempt + 1 &&
      retryableProfileStatuses.has(row.last_status)
    );
  }
  function acquire(verifiedOwner, operation) {
    if (!["telegram_auth", "session_verify"].includes(operation))
      throw fail("invalid_owner_operation");
    const ownerKey = registry.ownerKey(verifiedOwner);
    const leaseId = randomUUID();
    transaction(() => {
      if (
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_owner_leases WHERE owner_key = ? LIMIT 1",
          )
          .get(ownerKey)
      )
        throw fail("owner_lease_in_flight");
      if (
        routeWitness?.hasOwner(ownerKey) ||
        db
          .prepare("SELECT 1 FROM mobile_bridge_accounts WHERE owner_key = ?")
          .get(ownerKey) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
          )
          .get(ownerKey)
      )
        throw fail("bridge_route_required");
      routeWitness?.beginLease(leaseId, ownerKey, null);
      db.prepare(
        "INSERT INTO mobile_bridge_owner_leases (lease_id, owner_key, phase, operation, created_at) VALUES (?, ?, 'prepared', ?, ?)",
      ).run(leaseId, ownerKey, operation, Date.now());
      db.prepare(
        "INSERT INTO mobile_bridge_owner_lease_steps (lease_id, stage, attempt) VALUES (?, ?, 0)",
      ).run(
        leaseId,
        operation === "telegram_auth" ? "auth_ready" : "profile_ready",
      );
    });
    return leaseId;
  }
  function markDispatched(verifiedOwner, leaseId) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    const result = db
      .prepare(
        "UPDATE mobile_bridge_owner_leases SET phase = 'dispatched' WHERE owner_key = ? AND lease_id = ? AND phase = 'prepared'",
      )
      .run(ownerKey, leaseId);
    if (result.changes !== 1) throw fail("owner_lease_invalid");
  }
  function finish(verifiedOwner, leaseId, { definitelyFinished = false } = {}) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    if (definitelyFinished !== true) throw fail("owner_lease_unresolved");
    const deleted = transaction(() => {
      const row = db
        .prepare(
          "SELECT 1 FROM mobile_bridge_owner_leases WHERE owner_key = ? AND lease_id = ?",
        )
        .get(ownerKey, leaseId);
      if (!row) return false;
      db.prepare(
        "DELETE FROM mobile_bridge_owner_lease_steps WHERE lease_id = ?",
      ).run(leaseId);
      return (
        db
          .prepare(
            "DELETE FROM mobile_bridge_owner_leases WHERE owner_key = ? AND lease_id = ?",
          )
          .run(ownerKey, leaseId).changes === 1
      );
    });
    if (deleted) routeWitness?.finishLease(leaseId);
    return deleted;
  }
  function pending(verifiedOwner) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    return db
      .prepare(
        "SELECT lease_id, phase, operation, created_at FROM mobile_bridge_owner_leases WHERE owner_key = ? ORDER BY created_at, lease_id",
      )
      .all(ownerKey)
      .map((row) => ({
        id: row.lease_id,
        phase: row.phase,
        operation: row.operation,
        createdAt: row.created_at,
      }));
  }
  function bindCredential(verifiedOwner, leaseId, credentialDigest) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    if (!validDigest(credentialDigest)) throw fail("owner_lease_step_invalid");
    return transaction(() => {
      const row = db
        .prepare(
          `SELECT l.phase, l.operation, s.stage, s.last_status, s.credential_digest
             FROM mobile_bridge_owner_leases l
             JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
            WHERE l.owner_key = ? AND l.lease_id = ?`,
        )
        .get(ownerKey, leaseId);
      if (
        row?.phase !== "dispatched" ||
        row.operation !== "telegram_auth" ||
        row.stage !== "auth_complete" ||
        !Number.isInteger(row.last_status) ||
        row.last_status < 200 ||
        row.last_status >= 300 ||
        row.credential_digest != null
      )
        throw fail("owner_lease_step_invalid");
      const changed = db
        .prepare(
          `UPDATE mobile_bridge_owner_lease_steps
              SET stage = 'profile_ready', attempt = 0, credential_digest = ?
            WHERE lease_id = ? AND stage = 'auth_complete'
              AND credential_digest IS NULL`,
        )
        .run(credentialDigest, leaseId).changes;
      if (changed !== 1) throw fail("owner_lease_step_invalid");
      return true;
    });
  }
  // Read-only queue admission. Dispatch must still call claimStep for its CAS.
  function canClaimStep(
    verifiedOwner,
    leaseId,
    step,
    attempt,
    credentialDigest = null,
  ) {
    let ownerKey;
    try {
      ownerKey = registry.ownerKey(verifiedOwner);
    } catch {
      return false;
    }
    return stepAllowed(ownerKey, leaseId, step, attempt, credentialDigest);
  }
  function claimStep(
    verifiedOwner,
    leaseId,
    step,
    attempt,
    credentialDigest = null,
  ) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    return transaction(() => {
      if (!stepAllowed(ownerKey, leaseId, step, attempt, credentialDigest))
        throw fail("owner_lease_step_invalid");
      const row = db
        .prepare(
          `SELECT stage, attempt, credential_digest
             FROM mobile_bridge_owner_lease_steps WHERE lease_id = ?`,
        )
        .get(leaseId);
      const nextStage =
        step === "telegram_auth" ? "auth_dispatched" : "profile_dispatched";
      const digest = credentialDigest ?? row.credential_digest ?? null;
      const changed = db
        .prepare(
          `UPDATE mobile_bridge_owner_lease_steps
              SET stage = ?, attempt = ?, credential_digest = ?
            WHERE lease_id = ? AND stage = ? AND attempt = ?`,
        )
        .run(
          nextStage,
          attempt,
          digest,
          leaseId,
          row.stage,
          row.attempt,
        ).changes;
      if (changed !== 1) throw fail("owner_lease_step_invalid");
      return true;
    });
  }
  function completeStep(verifiedOwner, leaseId, step, attempt, status) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    if (
      !["telegram_auth", "profile"].includes(step) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 3 ||
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599
    )
      throw fail("owner_lease_step_invalid");
    return transaction(() => {
      const row = db
        .prepare(
          `SELECT l.phase, l.operation, s.stage, s.attempt
             FROM mobile_bridge_owner_leases l
             JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
            WHERE l.owner_key = ? AND l.lease_id = ?`,
        )
        .get(ownerKey, leaseId);
      const expectedStage =
        step === "telegram_auth" ? "auth_dispatched" : "profile_dispatched";
      if (
        row?.phase !== "dispatched" ||
        row.stage !== expectedStage ||
        row.attempt !== attempt ||
        (step === "telegram_auth" && row.operation !== "telegram_auth") ||
        (step === "profile" &&
          !["telegram_auth", "session_verify"].includes(row.operation))
      )
        throw fail("owner_lease_step_invalid");
      const retry =
        step === "profile" &&
        attempt < 3 &&
        retryableProfileStatuses.has(status);
      const stage =
        step === "telegram_auth"
          ? "auth_complete"
          : retry
            ? "profile_retry_ready"
            : "profile_complete";
      const changed = db
        .prepare(
          `UPDATE mobile_bridge_owner_lease_steps
              SET stage = ?, last_status = ?
            WHERE lease_id = ? AND stage = ? AND attempt = ?`,
        )
        .run(stage, status, leaseId, expectedStage, attempt).changes;
      if (changed !== 1) throw fail("owner_lease_step_invalid");
      return true;
    });
  }
  function canRegisterProfile(verifiedOwner, leaseId, credentialDigest) {
    let ownerKey;
    try {
      ownerKey = registry.ownerKey(verifiedOwner);
    } catch {
      return false;
    }
    if (!validDigest(credentialDigest)) return false;
    const row = db
      .prepare(
        `SELECT l.phase, s.stage, s.credential_digest, s.last_status
           FROM mobile_bridge_owner_leases l
           JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
          WHERE l.owner_key = ? AND l.lease_id = ?`,
      )
      .get(ownerKey, leaseId);
    return (
      row?.phase === "dispatched" &&
      row.stage === "profile_complete" &&
      row.credential_digest === credentialDigest &&
      Number.isInteger(row.last_status) &&
      row.last_status >= 200 &&
      row.last_status < 300
    );
  }
  function canFinishKnownProfileFailure(verifiedOwner, leaseId) {
    let ownerKey;
    try {
      ownerKey = registry.ownerKey(verifiedOwner);
    } catch {
      return false;
    }
    const row = db
      .prepare(
        `SELECT l.phase, l.operation, s.stage, s.last_status
           FROM mobile_bridge_owner_leases l
           JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
          WHERE l.owner_key = ? AND l.lease_id = ?`,
      )
      .get(ownerKey, leaseId);
    return (
      row?.phase === "dispatched" &&
      row.operation === "telegram_auth" &&
      ["profile_retry_ready", "profile_complete"].includes(row.stage) &&
      Number.isInteger(row.last_status) &&
      row.last_status >= 300 &&
      row.last_status <= 599
    );
  }
  function finishKnownProfileFailure(verifiedOwner, leaseId) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    const deleted = transaction(() => {
      const row = db
        .prepare(
          `SELECT l.phase, l.operation, s.stage, s.credential_digest,
                  s.last_status
             FROM mobile_bridge_owner_leases l
             JOIN mobile_bridge_owner_lease_steps s ON s.lease_id = l.lease_id
            WHERE l.owner_key = ? AND l.lease_id = ?`,
        )
        .get(ownerKey, leaseId);
      if (
        row?.phase !== "dispatched" ||
        row.operation !== "telegram_auth" ||
        !["profile_retry_ready", "profile_complete"].includes(row.stage) ||
        !validDigest(row.credential_digest) ||
        !Number.isInteger(row.last_status) ||
        row.last_status < 300 ||
        row.last_status > 599
      )
        return false;
      db.prepare(
        "DELETE FROM mobile_bridge_owner_lease_steps WHERE lease_id = ?",
      ).run(leaseId);
      return (
        db
          .prepare(
            "DELETE FROM mobile_bridge_owner_leases WHERE owner_key = ? AND lease_id = ? AND phase = 'dispatched'",
          )
          .run(ownerKey, leaseId).changes === 1
      );
    });
    if (deleted) routeWitness?.finishLease(leaseId);
    return deleted;
  }
  return Object.freeze({
    acquire,
    markDispatched,
    finish,
    pending,
    bindCredential,
    canClaimStep,
    claimStep,
    completeStep,
    canRegisterProfile,
    canFinishKnownProfileFailure,
    finishKnownProfileFailure,
  });
}
