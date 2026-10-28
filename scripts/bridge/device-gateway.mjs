import { WebSocketServer } from "ws";

const DEVICE_AUTH = /^MadhouseBridge ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

/**
 * Upgrade boundary for an HTTPS server or trusted local TLS-terminating proxy.
 * Peer IP must come from the trusted server adapter, never a client header.
 * Not attached to the Wiki runtime until its readiness gates are satisfied.
 */
export function createDeviceGateway({
  service,
  registry,
  consume,
  heartbeatMs = 15000,
} = {}) {
  if (
    !service ||
    !registry ||
    typeof consume !== "function" ||
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < 1000
  )
    throw new TypeError("invalid_gateway_dependencies");
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  let closed = false;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || ws.bridgeAlive === false) {
        ws.terminate();
        continue;
      }
      ws.bridgeAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  async function upgrade(req, socket, head, clientIp) {
    const reject = () => {
      if (!socket.destroyed) socket.destroy();
    };
    try {
      if (
        closed ||
        req.method !== "GET" ||
        req.url !== "/bridge/data" ||
        typeof clientIp !== "string" ||
        !clientIp ||
        (await consume(clientIp)) !== true
      )
        return reject();
      const raw = req.rawHeaders || [];
      let count = 0;
      for (let i = 0; i < raw.length; i += 2)
        if (raw[i].toLowerCase() === "authorization") count += 1;
      if (count !== 1) return reject();
      const match = DEVICE_AUTH.exec(req.headers.authorization || "");
      if (
        !match ||
        !registry.authenticateDevice(match[1], match[2]) ||
        closed ||
        socket.destroyed
      )
        return reject();
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.bridgeAlive = true;
        ws.on("pong", () => {
          ws.bridgeAlive = true;
        });
        ws.on("error", () => {});
        service
          .admit({ deviceId: match[1], deviceKey: match[2] }, ws)
          .catch(() => ws.terminate());
      });
    } catch {
      reject();
    }
  }

  function close() {
    closed = true;
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }
  return Object.freeze({ upgrade, close });
}
