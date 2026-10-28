import { Agent, request } from "node:https";
import {
  CARGO_HOST,
  createGameTlsDuplexConnector,
} from "./tls-duplex-connector.mjs";

const MAX_PROFILE_BYTES = 1024 * 1024;
const PROFILE_TIMEOUT_MS = 20_000;

/** Read-only profile over one authenticated tunnel. Never performs a direct retry. */
export function readProfileOverBridge({
  authorization,
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
        method: "GET",
        path: "/api/me",
        headers: { Accept: "application/json", Authorization: authorization },
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
          resolve({ status: response.statusCode, body: Buffer.concat(chunks) });
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
    req.end();
  });
}
