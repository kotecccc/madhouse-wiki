import { createHash } from "node:crypto";
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
  async function request(url, init = {}, source = "wiki") {
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
  return { request, close: executor.close, diagnostics: executor.diagnostics };
}
