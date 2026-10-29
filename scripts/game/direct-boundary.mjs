import { createHash, randomUUID } from "node:crypto";
import { createDirectExecutor } from "./direct-executor.mjs";

function setting(env, name, fallback, maximum) {
  if (env[name] == null || env[name] === "") return fallback;
  if (!/^\d+$/.test(env[name])) throw new Error(`${name} must be an integer`);
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} is out of range`);
  return value;
}

// Only confirmed /api/me responses establish a player ID. Before that a
// credential digest is a provisional scope and all requests share VPS pacing.
export function createDirectBoundary({
  env = {},
  fetcher = fetch,
  resolvePlayer = () => null,
  requireBridgeJournal = false,
} = {}) {
  const executor = createDirectExecutor({
    fetcher,
    minGlobalSpacingMs: setting(
      env,
      "MADHOUSE_GAME_GLOBAL_INTERVAL_MS",
      300,
      60000,
    ),
    minAccountSpacingMs: setting(
      env,
      "MADHOUSE_GAME_ACCOUNT_INTERVAL_MS",
      1100,
      60000,
    ),
    minDeviceSpacingMs: setting(
      env,
      "MADHOUSE_GAME_DEVICE_INTERVAL_MS",
      300,
      60000,
    ),
    maxDirectInFlight: setting(env, "MADHOUSE_GAME_DIRECT_CONCURRENCY", 4, 128),
    maxQueueSize: setting(env, "MADHOUSE_GAME_QUEUE_LIMIT", 100, 10000),
    maxQueueWaitMs: setting(env, "MADHOUSE_GAME_QUEUE_WAIT_MS", 20000, 120000),
    ...(env.MADHOUSE_GAME_DIAGNOSTICS === "1"
      ? {
          onDiagnostic: (event) =>
            console.info("madhouse-direct-game", JSON.stringify(event)),
        }
      : {}),
  });
  const players = new Map();
  let bridgeStore = null;
  let recoveryReady = !requireBridgeJournal;
  function installBridgeStore(store) {
    if (
      bridgeStore ||
      typeof store?.readActiveBridgeAttempts !== "function" ||
      typeof store?.createBridgeAttempt !== "function" ||
      typeof store?.compareAndSetBridgeAttempt !== "function"
    )
      throw new Error("bridge_attempt_store_invalid");
    // Read and restore every restriction before allowing the worker to boot.
    const active = store.readActiveBridgeAttempts();
    for (const attempt of active) {
      if (attempt.phase === "prepared") {
        // No HTTP function is called before the durable dispatched transition.
        if (
          !store.compareAndSetBridgeAttempt(attempt.id, attempt.revision, {
            phase: "rejected",
            updatedAt: Math.max(attempt.updatedAt, Date.now()),
          })
        )
          throw new Error("bridge_attempt_stale");
      } else {
        executor.blockAttempt(
          attempt.id,
          `player:${attempt.playerId}`,
          attempt.deviceId,
        );
      }
    }
    bridgeStore = store;
    recoveryReady = true;
  }
  function account(authorization, playerId) {
    const digest = authorization
      ? createHash("sha256").update(authorization).digest("hex")
      : null;
    const verified = /^[1-9][0-9]*$/.test(String(playerId || ""))
      ? `player:${playerId}`
      : null;
    if (digest && verified) {
      executor.bindAccount(digest, verified);
      players.set(digest, verified);
    }
    return digest ? players.get(digest) || digest : undefined;
  }
  function bridge({
    authorization,
    playerId,
    deviceId,
    signal,
    method,
    execute,
    kind,
    operationId,
    bindingRevision,
    deviceGeneration,
  }) {
    if (!recoveryReady)
      return Promise.reject(
        Object.assign(new Error("bridge_recovery_not_ready"), {
          notDispatched: true,
        }),
      );
    const accountId = account(authorization, playerId);
    const guarded = async () => {
      if (kind !== "mutation") return execute();
      if (!bridgeStore) {
        if (!requireBridgeJournal) return execute();
        throw Object.assign(new Error("bridge_attempt_store_unavailable"), {
          notDispatched: true,
        });
      }
      let attempt;
      const attemptId = randomUUID();
      try {
        const timestamp = Date.now();
        attempt = bridgeStore.createBridgeAttempt({
          id: attemptId,
          playerId,
          operationId,
          deviceId,
          bindingRevision,
          deviceGeneration,
          action: "mutation",
          phase: "prepared",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const dispatched = bridgeStore.compareAndSetBridgeAttempt(
          attempt.id,
          attempt.revision,
          { phase: "dispatched", updatedAt: timestamp },
        );
        if (!dispatched) throw new Error("bridge_attempt_stale");
        attempt = dispatched;
      } catch (error) {
        executor.blockAttempt(attemptId, accountId, deviceId);
        throw Object.assign(error, { notDispatched: true });
      }
      let result;
      try {
        result = await execute();
      } catch (error) {
        const phase = error?.notDispatched ? "rejected" : "uncertain";
        try {
          if (
            !bridgeStore.compareAndSetBridgeAttempt(
              attempt.id,
              attempt.revision,
              { phase, updatedAt: Math.max(attempt.updatedAt, Date.now()) },
            )
          )
            throw new Error("bridge_attempt_stale", { cause: error });
        } catch {
          executor.blockAttempt(attempt.id, accountId, deviceId);
          throw Object.assign(new Error("bridge_attempt_store_unavailable"), {
            cause: error,
          });
        }
        if (phase === "uncertain")
          executor.blockAttempt(attempt.id, accountId, deviceId);
        throw error;
      }
      try {
        if (
          !bridgeStore.compareAndSetBridgeAttempt(
            attempt.id,
            attempt.revision,
            {
              phase: "completed",
              updatedAt: Math.max(attempt.updatedAt, Date.now()),
            },
          )
        )
          throw new Error("bridge_attempt_stale");
      } catch (error) {
        executor.blockAttempt(attempt.id, accountId, deviceId);
        throw error;
      }
      return result;
    };
    return executor.bridge(
      guarded,
      { signal, method },
      {
        accountId,
        deviceId,
        signal,
        source: method && method !== "GET" ? "automation" : "wiki",
        cooldownScope: authorization ? "account" : "global",
      },
    );
  }
  async function request(url, init = {}, source = "wiki") {
    if (!recoveryReady)
      throw Object.assign(new Error("bridge_recovery_not_ready"), {
        notDispatched: true,
      });
    const { gameAttempt, gameSource, ...requestInit } = init;
    const authorization = new Headers(init.headers).get("authorization");
    const digest = authorization
      ? createHash("sha256").update(authorization).digest("hex")
      : null;
    const playerId = authorization && resolvePlayer(authorization);
    const verified =
      Number.isSafeInteger(playerId) && playerId > 0
        ? `player:${playerId}`
        : null;
    if (digest && verified) {
      executor.bindAccount(digest, verified);
      players.set(digest, verified);
    }
    const accountId = digest ? players.get(digest) || digest : undefined;
    const result = await executor.request(url, requestInit, {
      accountId,
      source: gameSource || source,
      attempt: gameAttempt,
      cooldownScope: digest ? "account" : "global",
    });
    if (
      digest &&
      (init.method || "GET").toUpperCase() === "GET" &&
      new URL(url).pathname === "/api/me" &&
      result.ok
    ) {
      try {
        const profile = await result.clone().json();
        if (Number.isSafeInteger(profile?.playerId) && profile.playerId > 0) {
          if (players.size >= 10000)
            players.delete(players.keys().next().value);
          const verified = `player:${profile.playerId}`;
          executor.bindAccount(digest, verified);
          players.set(digest, verified);
        }
      } catch {
        // A malformed response never establishes identity.
      }
    }
    return result;
  }
  return {
    request,
    bridge,
    bindVerified: account,
    installBridgeStore,
    close: executor.close,
    diagnostics: executor.diagnostics,
  };
}
