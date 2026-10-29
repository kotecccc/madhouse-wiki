import { INVENTORY_ACTION_TYPES } from "../automation/inventory-actions.mjs";
import { Agent, request } from "node:https";
import { createHash } from "node:crypto";
import { gameReadPaths } from "./game-read-paths.mjs";
import {
  CARGO_HOST,
  createGameTlsDuplexConnector,
} from "./tls-duplex-connector.mjs";

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const PROFILE_TIMEOUT_MS = 30_000;
const invitationReasons = new Set([
  "battle_not_found",
  "battle_full",
  "battle_busy",
  "battle_finished",
  "battle_not_active",
  "battle_already_finished",
  "battle_ending",
  "battle_expired",
  "boss_battle_finished",
  "boss_battle_not_active",
  "boss_battle_expired",
  "boss_battle_not_found",
  "boss_battle_already_active",
  "boss_fight_not_available",
  "boss_level_required",
  "boss_room_forbidden",
  "invitation_expired",
  "invitation_not_found",
  "invitation_not_pending",
  "invitation_already_accepted",
  "boss_invitation_expired",
  "boss_invitation_not_pending",
  "participant_already_left",
  "participant_already_joined",
  "room_full",
  "already_in_battle",
  "already_joined",
  "not_enough_energy",
  "not_enough_health",
  "insufficient_combat_energy",
  "insufficient_energy",
  "combat_cooldown",
  "weapon_broken",
]);

// Only fixed field names, known codes and hashes reach the log; server text,
// account identifiers and credentials are never logged.
export function invitationResponseDiagnostic(body) {
  try {
    const value = JSON.parse(body.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return { reason: "other", fingerprints: "non_object" };
    const fingerprints = [];
    let reason = "other";
    for (const field of ["reason", "error", "errorCode", "code", "message"]) {
      const item = value[field];
      if (typeof item !== "string" || item.length > 512) continue;
      if (invitationReasons.has(item)) reason = item;
      fingerprints.push(
        `${field}:${createHash("sha256").update(item).digest("hex").slice(0, 16)}`,
      );
    }
    return {
      reason,
      fingerprints: fingerprints.join(",") || "no_string_fields",
    };
  } catch {
    return { reason: "other", fingerprints: "non_json" };
  }
}
const documentedReadPaths = gameReadPaths.map(
  (path) =>
    new RegExp(
      `^${path
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[A-Za-z0-9_$-]+")}$`,
    ),
);
const readPaths = [
  ...documentedReadPaths,
  /^\/api\/me$/,
  /^\/api\/me\/bag$/,
  /^\/api\/floors$/,
  /^\/api\/floors\/[A-Za-z0-9_$-]+\/(?:info|leaderboard)$/,
  /^\/api\/friends(?:\/requests\/(?:incoming|outgoing)|\/search(?:\/suggestions)?)?$/,
  /^\/api\/players\/[A-Za-z0-9_$-]+(?:\/achievements|\/bosses\/statistics)?$/,
];

export function isAllowedGameRead(path) {
  return (
    typeof path === "string" &&
    path.length <= 4096 &&
    !/[\r\n#\\]/.test(path) &&
    readPaths.some((pattern) => pattern.test(path.split("?", 1)[0]))
  );
}

// The existing work UI uses this POST to read the work view; accept no other
// fields so this exception cannot become a generic mutation transport.
export function isAllowedWorkView(method, path, body) {
  if (
    method !== "POST" ||
    path !== "/api/works/open" ||
    typeof body !== "string" ||
    body.length > 256
  )
    return false;
  try {
    const value = JSON.parse(body);
    return (
      value &&
      Object.keys(value).sort().join(",") === "locale,workId" &&
      value.locale === "ru" &&
      Number.isSafeInteger(value.workId) &&
      value.workId > 0
    );
  } catch {
    return false;
  }
}

/** Selected read-only game data over an authenticated tunnel. */
function requestGameOverBridge({
  authorization,
  path,
  method,
  body,
  openTunnel,
  validateTunnel = null,
  signal,
  onTransportStopped,
  // Set before Node can flush the buffered request to the connected TLS socket.
  attemptState = { mayHaveSent: false },
  // Tests may provide an injected connector; the production default verifies Cargo TLS.
  connector = createGameTlsDuplexConnector({
    openTunnel,
    validateTunnel,
    signal,
    onReady: () => {
      attemptState.mayHaveSent = true;
    },
    onTunnel: (tunnel) => {
      attemptState.tunnel = tunnel;
    },
    requestInfo: { method, path },
  }),
} = {}) {
  if (
    typeof authorization !== "string" ||
    !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
    typeof connector !== "function"
  )
    throw new TypeError("invalid_profile_request");

  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = connector;
    let stopping = false;
    const req = request(
      {
        protocol: "https:",
        hostname: CARGO_HOST,
        port: 443,
        method,
        path,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          ...(body
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
        agent,
      },
      (response) => {
        const socket = attemptState.tunnel?.socket;
        const pathname = path.split("?", 1)[0];
        if (
          socket?.bridgeRequestLog &&
          socket.readyState === 1 &&
          /^(GET|POST|PUT|DELETE)$/.test(method) &&
          /^\/api\/[A-Za-z0-9_/$%.-]{1,250}$/.test(pathname) &&
          Number.isInteger(response.statusCode) &&
          response.statusCode >= 100 &&
          response.statusCode <= 599
        ) {
          try {
            socket.send(
              JSON.stringify({
                type: "response",
                method,
                path: pathname,
                status: response.statusCode,
              }),
              { binary: false },
              () => {},
            );
          } catch {
            // Diagnostics must not affect the game request.
          }
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_PROFILE_BYTES) {
            response.destroy(
              Object.assign(new Error("profile_too_large"), {
                code: "profile_too_large",
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("aborted", () => reject(new Error("profile_incomplete")));
        response.once("end", () => {
          // Once cancellation starts, a racing response cannot authorize the
          // boundary to treat this operation as an ordinary completed attempt.
          if (stopping) return;
          if (!response.complete) {
            reject(new Error("profile_incomplete"));
            return;
          }
          const responseBody = Buffer.concat(chunks);
          if (
            method === "POST" &&
            /^\/api\/bosses\/invitations\/[A-Za-z0-9_-]{1,120}\/accept$/.test(
              path,
            )
          ) {
            const { reason, fingerprints } =
              invitationResponseDiagnostic(responseBody);
            console.info(
              "madhouse-bridge-invitation-status",
              response.statusCode,
              createHash("sha256").update(path).digest("hex").slice(0, 12),
              reason,
              fingerprints,
            );
          }
          const retryAfter = response.headers["retry-after"];
          resolve({
            status: response.statusCode,
            body: responseBody,
            ...(typeof retryAfter === "string" && retryAfter.length <= 128
              ? { retryAfter }
              : {}),
          });
        });
      },
    );
    const stop = (error) => {
      if (stopping || req.destroyed) return;
      stopping = true;
      void (async () => {
        if (
          attemptState.mayHaveSent &&
          typeof attemptState.tunnel?.stopAndWait === "function"
        ) {
          try {
            if (await attemptState.tunnel.stopAndWait())
              await onTransportStopped?.();
          } catch {
            // A missing or unpersisted proof never authorizes recovery.
          }
        }
        req.destroy(error);
        reject(error);
      })();
    };
    const abort = () =>
      stop(
        Object.assign(new Error("bridge_cancelled"), {
          code: "bridge_cancelled",
        }),
      );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => stop(new Error("profile_timeout")),
      PROFILE_TIMEOUT_MS,
    );
    timer.unref?.();
    req.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      agent.destroy();
    });
    req.once("error", (error) => {
      if (!attemptState.mayHaveSent) error.notDispatched = true;
      reject(error);
    });
    req.end(body);
  });
}

export function readGameOverBridge(options = {}) {
  if (
    !(
      (options.method == null || options.method === "GET") &&
      options.body == null &&
      isAllowedGameRead(options.path)
    ) &&
    !isAllowedWorkView(options.method, options.path, options.body)
  )
    throw new TypeError("invalid_profile_request");
  return requestGameOverBridge({ ...options, method: options.method || "GET" });
}

export function isBattleActionRoute(method, path) {
  return (
    method === "POST" &&
    (/^\/api\/bosses\/invitations\/[A-Za-z0-9_-]{1,120}\/accept$/.test(path) ||
      path === "/api/stash/craft" ||
      path === "/api/character-stats/upgrade" ||
      /^\/api\/businesses\/[1-9][0-9]*\/upgrade$/.test(path) ||
      path === "/api/me/bag/combat-items/buy" ||
      /^\/api\/bosses\/battles\/[A-Za-z0-9_-]{1,120}\/items\/use$/.test(path) ||
      /^\/api\/bosses\/battles\/[A-Za-z0-9_-]{1,120}\/invitations\/bulk$/.test(
        path,
      ) ||
      /^\/api\/bosses\/[1-9][0-9]*\/battles$/.test(path) ||
      /^\/api\/bosses\/battles\/[A-Za-z0-9_-]{1,120}\/attack$/.test(path))
  );
}

export function isInventoryActionRoute(method, path) {
  if (method === "POST" && path === "/api/weapons/repair") return true;
  return Object.values(INVENTORY_ACTION_TYPES).some(
    (def) =>
      (method === "POST" && path === def.buy) ||
      (method === def.method && path === def.equip) ||
      (method === "DELETE" &&
        def.remove &&
        (def.remove.endsWith("/")
          ? new RegExp(`^${def.remove}[1-9][0-9]*$`).test(path)
          : path === def.remove)),
  );
}

/** Only the queue may supply the handshake-time permission for this action. */
export function sendFriendResponseOverBridge(options = {}) {
  const { method, path, validateTunnel } = options;
  if (
    typeof validateTunnel !== "function" ||
    typeof path !== "string" ||
    !(
      isInventoryActionRoute(method, path) ||
      isBattleActionRoute(method, path) ||
      (method === "POST" &&
        ([
          "/api/friends/requests",
          "/api/me/bag/boosters/use",
          "/api/me/bag/boosters/buy",
        ].includes(path) ||
          /^\/api\/friends\/requests\/[1-9][0-9]*\/accept$/.test(path))) ||
      (method === "DELETE" &&
        /^\/api\/friends\/(?:requests\/)?[1-9][0-9]*$/.test(path))
    )
  )
    throw new TypeError("invalid_queued_action");
  return requestGameOverBridge({
    ...options,
    body:
      isInventoryActionRoute(method, path) || isBattleActionRoute(method, path)
        ? options.body
        : method === "POST"
          ? [
              "/api/friends/requests",
              "/api/me/bag/boosters/use",
              "/api/me/bag/boosters/buy",
            ].includes(path)
            ? options.body
            : "{}"
          : undefined,
  });
}

/** A work mutation requires a separate checkpoint-bound handshake permission. */
export function sendWorkTaskOverBridge(options = {}) {
  const { method, path, body, validateTunnel } = options;
  if (
    method !== "POST" ||
    path !== "/api/works/tasks/perform" ||
    typeof body !== "string" ||
    body.length > 1024 ||
    typeof validateTunnel !== "function"
  )
    throw new TypeError("invalid_work_action");
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    throw new TypeError("invalid_work_action");
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "locale,operationId,taskId,workId" ||
    value.locale !== "ru" ||
    !Number.isSafeInteger(value.workId) ||
    value.workId <= 0 ||
    !Number.isSafeInteger(value.taskId) ||
    value.taskId <= 0 ||
    typeof value.operationId !== "string" ||
    !value.operationId ||
    value.operationId.length > 256
  )
    throw new TypeError("invalid_work_action");
  return requestGameOverBridge(options);
}

/** Read-only profile over one authenticated tunnel. Never performs a direct retry. */
export function readProfileOverBridge(options = {}) {
  return readGameOverBridge({ ...options, path: "/api/me" });
}
