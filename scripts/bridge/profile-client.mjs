import { Agent, request } from "node:https";
import {
  CARGO_HOST,
  createGameTlsDuplexConnector,
} from "./tls-duplex-connector.mjs";

const MAX_PROFILE_BYTES = 4 * 1024 * 1024;
const PROFILE_TIMEOUT_MS = 20_000;
const readPaths = [
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
  // Tests may provide an injected connector; the production default verifies Cargo TLS.
  connector = createGameTlsDuplexConnector({ openTunnel, validateTunnel }),
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
        signal,
      },
      (response) => {
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
          if (!response.complete) {
            reject(new Error("profile_incomplete"));
            return;
          }
          const retryAfter = response.headers["retry-after"];
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks),
            ...(typeof retryAfter === "string" && retryAfter.length <= 128
              ? { retryAfter }
              : {}),
          });
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("profile_timeout")),
      PROFILE_TIMEOUT_MS,
    );
    timer.unref?.();
    req.once("close", () => {
      clearTimeout(timer);
      agent.destroy();
    });
    req.once("error", reject);
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

/** Only the queue may supply the handshake-time permission for this action. */
export function sendFriendResponseOverBridge(options = {}) {
  const { method, path, validateTunnel } = options;
  if (
    typeof validateTunnel !== "function" ||
    typeof path !== "string" ||
    !(
      (method === "POST" &&
        /^\/api\/friends\/requests\/[1-9][0-9]*\/accept$/.test(path)) ||
      (method === "DELETE" &&
        /^\/api\/friends\/requests\/[1-9][0-9]*$/.test(path))
    )
  )
    throw new TypeError("invalid_queued_action");
  return requestGameOverBridge({
    ...options,
    body: method === "POST" ? "{}" : undefined,
  });
}

/** Read-only profile over one authenticated tunnel. Never performs a direct retry. */
export function readProfileOverBridge(options = {}) {
  return readGameOverBridge({ ...options, path: "/api/me" });
}
