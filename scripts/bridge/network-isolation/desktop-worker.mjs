import { connect as connectTcp } from "node:net";
import { WebSocket } from "ws";
import { createDesktopGatewayClient } from "/bridge/apps/desktop/src/main/gateway-client.mjs";

const deviceId = "00000000-0000-4000-8000-000000000401";
const connectionId = "00000000-0000-4000-8000-000000000402";
const sessionCredential = "fixture.device.session";

class DiagnosticWebSocket extends WebSocket {
  constructor(...args) {
    super(...args);
    this.once("close", (code, reason) => {
      console.log(`DESKTOP_WS_CLOSED ${code} ${reason.toString("utf8")}`);
    });
    this.once("error", (error) => {
      console.log(`DESKTOP_WS_ERROR ${error.code || "socket_error"}`);
    });
  }

  send(data, options, callback) {
    if (typeof data === "string") {
      try {
        const message = JSON.parse(data);
        console.log(
          `DESKTOP_CONTROL_SEND ${message.type} ${message.transportError || ""}`,
        );
      } catch {
        console.log("DESKTOP_CONTROL_SEND invalid_json");
      }
    }
    return super.send(data, options, callback);
  }
}

const client = createDesktopGatewayClient({
  WebSocketClass: DiagnosticWebSocket,
  acquireSession: async () => ({
    deviceId,
    connectionId,
    deviceGeneration: 1,
    routeEpoch: 1,
    expiresAtMs: Date.now() + 120_000,
    sessionCredential,
  }),
  controlUrl: "ws://wiki:8787/bridge/control",
  dataUrl: "ws://wiki:8787/bridge/data",
  tcpConnect(port, host) {
    if (port !== 443 || host !== "cargohustle.online")
      throw new Error("relay_target_invalid");
    const socket = connectTcp(port, host);
    socket.once("error", (error) => {
      console.log(`DESKTOP_TCP_ERROR ${error.code || "socket_error"}`);
    });
    return socket;
  },
  onStatusChange(status) {
    console.log(
      `DESKTOP_STATUS ${status.deviceStatus}:${status.pauseReasons.join(",")}`,
    );
  },
});

const status = await client.connect();
if (status.deviceStatus !== "online")
  throw new Error("desktop_control_not_ready");
const ready = await fetch("http://wiki:8787/desktop-online", {
  method: "POST",
});
if (ready.status !== 204) throw new Error("wiki_ready_signal_failed");
console.log("DESKTOP_READY");

const keepAlive = setInterval(() => {}, 60_000);
process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  client.disconnect();
  console.log("DESKTOP_STOPPED");
});
