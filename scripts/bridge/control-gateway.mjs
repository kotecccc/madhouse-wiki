import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { isUuid } from "./protocol-v1/common.mjs";
import {
  MAX_CONTROL_FRAME_BYTES,
  MAX_DATA_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseControlFrame,
} from "./protocol-v1/index.mjs";
import { createStreamTicketRegistry } from "./stream-ticket-registry.mjs";
import { WebSocketDuplex } from "./websocket-duplex.mjs";

const CONTROL_PATH = "/bridge/control";
const DATA_PATH = "/bridge/data";
const SERVER_CAPABILITIES = Object.freeze([
  "cargo-byte-tunnel-v1",
  "official-game-launch-v1",
  "helper-pause-v1",
]);
const HELLO_TIMEOUT_MS = 5000;
const STREAM_READY_TIMEOUT_MS = 15_000;
const GAME_LAUNCH_TIMEOUT_MS = 35_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_STALE_MS = 60_000;
const MAX_PENDING_PINGS = 3;
const UPGRADE_TIMEOUT_MS = 5_000;
// Conservative admission bounds, not a claim about measured host capacity.
export const MAX_CONTROL_CONNECTIONS = 128;
export const MAX_PENDING_UPGRADES = 64;

function response(socket, status, phrase) {
  const body = `${phrase}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${phrase}\r\n` +
      "Connection: close\r\n" +
      "Cache-Control: no-store\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function bearerCredential(value) {
  if (
    typeof value !== "string" ||
    value.length > 2055 ||
    !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
  )
    return null;
  return value.slice(7);
}

function monotonicTime(readClock) {
  try {
    const value = readClock();
    if (!Number.isFinite(value) || value < 0) return null;
    return value;
  } catch {
    return null;
  }
}

function validSession(session, scope) {
  return (
    session &&
    typeof session.ownerId === "string" &&
    /^[1-9][0-9]{0,15}$/u.test(session.ownerId) &&
    isUuid(session.deviceId) &&
    Number.isSafeInteger(session.deviceGeneration) &&
    session.deviceGeneration > 0 &&
    isUuid(session.connectionId) &&
    Number.isSafeInteger(session.routeEpoch) &&
    session.routeEpoch > 0 &&
    Number.isSafeInteger(session.expiresAtMs) &&
    Array.isArray(session.scopes) &&
    session.scopes.includes(scope)
  );
}

function sameSession(left, right) {
  return (
    left.ownerId === right.ownerId &&
    left.deviceId === right.deviceId &&
    left.deviceGeneration === right.deviceGeneration &&
    left.connectionId === right.connectionId &&
    left.routeEpoch === right.routeEpoch
  );
}

function gatewayError(code) {
  return Object.assign(new Error(code), { code });
}

export function createBridgeControlGateway({
  registry,
  sessionSigningKey,
  origin = "https://madhouse-wiki.ru",
  enabled = false,
  monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000,
  random = randomBytes,
  uuid = randomUUID,
  wallNow = Date.now,
  streamReadyTimeoutMs = STREAM_READY_TIMEOUT_MS,
  scheduleHeartbeat = setInterval,
  cancelHeartbeat = clearInterval,
  maxControlConnections = MAX_CONTROL_CONNECTIONS,
  maxPendingUpgrades = MAX_PENDING_UPGRADES,
  upgradeTimeoutMs = UPGRADE_TIMEOUT_MS,
} = {}) {
  if (typeof registry?.authorizeDeviceSession !== "function")
    throw new TypeError("bridge_session_authorizer_required");
  if (
    typeof registry?.getHelperPaused !== "function" ||
    typeof registry?.setHelperPaused !== "function"
  )
    throw new TypeError("bridge_helper_control_required");
  if (
    !Number.isSafeInteger(streamReadyTimeoutMs) ||
    streamReadyTimeoutMs < 1000 ||
    streamReadyTimeoutMs > 60_000
  )
    throw new TypeError("bridge_stream_timeout_invalid");
  if (
    typeof scheduleHeartbeat !== "function" ||
    typeof cancelHeartbeat !== "function"
  )
    throw new TypeError("bridge_heartbeat_scheduler_invalid");
  if (
    !Number.isSafeInteger(maxControlConnections) ||
    maxControlConnections < 1 ||
    maxControlConnections > MAX_CONTROL_CONNECTIONS ||
    !Number.isSafeInteger(maxPendingUpgrades) ||
    maxPendingUpgrades < 1 ||
    maxPendingUpgrades > MAX_PENDING_UPGRADES
  )
    throw new TypeError("bridge_gateway_capacity_invalid");
  if (
    !Number.isSafeInteger(upgradeTimeoutMs) ||
    upgradeTimeoutMs < 10 ||
    upgradeTimeoutMs > 10_000
  )
    throw new TypeError("bridge_upgrade_timeout_invalid");
  let ticketRegistry = null;
  if (sessionSigningKey !== undefined && sessionSigningKey !== null)
    ticketRegistry = createStreamTicketRegistry({
      sessionSigningKey,
      now: wallNow,
      uuid,
    });
  let allowedOrigin;
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password
    )
      throw new TypeError();
    allowedOrigin = parsed.origin;
  } catch {
    throw new TypeError("bridge_gateway_origin_invalid");
  }

  const server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_DATA_FRAME_BYTES,
    perMessageDeflate: false,
    clientTracking: true,
  });
  const connections = new Map();
  let pendingUpgrades = 0;
  let closed = false;
  let draining = false;
  let drainFlight = null;
  const drainWaiters = new Set();

  function hasActiveWork() {
    for (const connection of connections.values())
      if (connection.activeStream || connection.pendingLaunch) return true;
    return false;
  }

  function resolveDrainWaitersIfIdle() {
    if (hasActiveWork()) return;
    for (const resolve of drainWaiters) resolve(true);
  }

  function waitForIdle(deadlineInMs) {
    if (!hasActiveWork()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (idle) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        drainWaiters.delete(onIdle);
        resolve(idle);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), deadlineInMs);
      drainWaiters.add(onIdle);
    });
  }

  function sendJson(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message), { binary: false });
      return true;
    }
    return false;
  }

  function settleStreamOpen(stream, error, duplex = null) {
    if (stream.openSettled) return;
    stream.openSettled = true;
    clearTimeout(stream.readyTimer);
    if (error) stream.rejectOpen(error);
    else stream.resolveOpen(duplex);
  }

  function clearStream(
    connection,
    stream,
    error,
    notifyDesktop = true,
    reason = error ? "transport_error" : "cancelled",
  ) {
    if (connection.activeStream !== stream) return;
    connection.activeStream = null;
    clearTimeout(stream.readyTimer);
    if (stream.signal && stream.abortHandler)
      stream.signal.removeEventListener("abort", stream.abortHandler);
    ticketRegistry?.clearConnection(connection.session.connectionId);
    if (notifyDesktop && connection.ready)
      sendJson(connection.socket, {
        type: "close_stream",
        streamId: stream.streamId,
        reason,
      });
    if (stream.dataSocket?.readyState === WebSocket.OPEN)
      stream.dataSocket.close(error ? 1011 : 1000, "stream_closed");
    if (stream.duplex && !stream.duplex.destroyed)
      stream.duplex.destroy(error || undefined);
    settleStreamOpen(stream, error || gatewayError("stream_closed"));
    resolveDrainWaitersIfIdle();
  }

  function cleanupConnection(connection) {
    if (connection.cleaned) return;
    connection.cleaned = true;
    clearTimeout(connection.helloTimer);
    cancelHeartbeat(connection.heartbeatTimer);
    if (connections.get(connection.session.deviceId) === connection)
      connections.delete(connection.session.deviceId);
    if (connection.pendingLaunch)
      finishLaunch(connection, connection.pendingLaunch, {
        status: "unavailable",
      });
    ticketRegistry?.clearConnection(connection.session.connectionId);
    if (connection.activeStream)
      clearStream(
        connection,
        connection.activeStream,
        gatewayError("bridge_offline"),
        false,
      );
    resolveDrainWaitersIfIdle();
  }

  function finishLaunch(
    connection,
    pending,
    result,
    { retainPending = false } = {},
  ) {
    if (!pending.settled) {
      pending.settled = true;
      pending.resolve(result);
    }
    if (retainPending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler)
      pending.signal.removeEventListener("abort", pending.abortHandler);
    if (connection.pendingLaunch === pending) connection.pendingLaunch = null;
    resolveDrainWaitersIfIdle();
  }

  function rememberIgnoredLaunch(connection, requestId) {
    if (connection.ignoredLaunchRequestIds.size >= 16)
      connection.ignoredLaunchRequestIds.delete(
        connection.ignoredLaunchRequestIds.values().next().value,
      );
    connection.ignoredLaunchRequestIds.add(requestId);
  }

  function closeConnection(connection, code, reason) {
    cleanupConnection(connection);
    if (connection.socket.readyState === WebSocket.OPEN)
      connection.socket.close(code, reason);
    else if (connection.socket.readyState === WebSocket.CONNECTING)
      connection.socket.terminate();
  }

  function maybeResolveStream(connection, stream) {
    if (
      connection.activeStream === stream &&
      stream.dataSocket &&
      stream.desktopReady &&
      stream.duplex
    ) {
      try {
        Object.defineProperty(stream.duplex, "bridgeConnectionId", {
          value: connection.session.connectionId,
          enumerable: false,
        });
      } catch {
        failStream(connection, stream, "stream_identity_unavailable");
        return;
      }
      settleStreamOpen(stream, null, stream.duplex);
    }
  }

  function failStream(connection, stream, code, notifyDesktop = true) {
    clearStream(connection, stream, gatewayError(code), notifyDesktop);
  }

  function acceptDataSocket(webSocket, connection, stream) {
    if (connection.activeStream !== stream || stream.dataSocket) {
      webSocket.close(1008, "stream_unavailable");
      return;
    }
    stream.dataSocket = webSocket;
    try {
      stream.duplex = new WebSocketDuplex(webSocket);
    } catch {
      failStream(connection, stream, "data_channel_closed");
      webSocket.close(1011, "data_channel_unavailable");
      return;
    }
    stream.duplex.once("error", () => {
      if (connection.activeStream === stream)
        failStream(connection, stream, "data_channel_closed");
    });
    webSocket.once("close", () => {
      if (connection.activeStream === stream)
        failStream(connection, stream, "data_channel_closed", false);
    });
    webSocket.once("error", () => {
      if (connection.activeStream === stream)
        failStream(connection, stream, "data_channel_closed");
    });
    maybeResolveStream(connection, stream);
  }

  function acceptConnection(socket, session, credential) {
    const connection = {
      socket,
      session,
      credential,
      ready: false,
      activeStream: null,
      cleaned: false,
      lastPongAtMs: monotonicTime(monotonicNow),
      pendingPings: new Set(),
      helloTimer: null,
      heartbeatTimer: null,
      negotiatedCapabilities: new Set(),
      pendingLaunch: null,
      ignoredLaunchRequestIds: new Set(),
    };
    connection.helloTimer = setTimeout(() => {
      closeConnection(connection, 1008, "hello_timeout");
    }, HELLO_TIMEOUT_MS);
    connection.helloTimer.unref?.();
    connections.set(session.deviceId, connection);
    socket.on("message", (data, isBinary) => {
      if (isBinary || data.byteLength > MAX_CONTROL_FRAME_BYTES) {
        closeConnection(connection, 1009, "invalid_control_frame");
        return;
      }
      let message;
      try {
        message = parseControlFrame(data.toString("utf8"));
      } catch {
        closeConnection(connection, 1008, "invalid_control_message");
        return;
      }
      if (!connection.ready) {
        if (message.type !== "hello") {
          closeConnection(connection, 1008, "hello_required");
          return;
        }
        if (message.capabilities.length === 0) {
          closeConnection(connection, 1008, "capability_required");
          return;
        }
        const negotiated = SERVER_CAPABILITIES.filter((capability) =>
          message.capabilities.includes(capability),
        );
        if (!negotiated.length) {
          closeConnection(connection, 1008, "capability_required");
          return;
        }
        clearTimeout(connection.helloTimer);
        connection.negotiatedCapabilities = new Set(negotiated);
        connection.ready = true;
        connection.lastPongAtMs = monotonicTime(monotonicNow);
        sendJson(socket, {
          type: "hello_ok",
          protocolMajor: PROTOCOL_VERSION.major,
          protocolMinor: PROTOCOL_VERSION.minor,
          connectionId: session.connectionId,
          heartbeatSeconds: HEARTBEAT_INTERVAL_MS / 1000,
          capabilities: negotiated,
        });
        if (connection.negotiatedCapabilities.has("helper-pause-v1")) {
          try {
            const paused = registry.getHelperPaused(session.ownerId);
            if (typeof paused !== "boolean")
              throw gatewayError("helper_state_invalid");
            sendJson(socket, { type: "helper_state", paused });
          } catch {
            closeConnection(connection, 1011, "helper_state_unavailable");
            return;
          }
        }
        connection.heartbeatTimer = scheduleHeartbeat(() => {
          const timestamp = monotonicTime(monotonicNow);
          if (
            timestamp === null ||
            connection.lastPongAtMs === null ||
            timestamp - connection.lastPongAtMs >= HEARTBEAT_STALE_MS ||
            connection.pendingPings.size >= MAX_PENDING_PINGS
          ) {
            closeConnection(connection, 4001, "heartbeat_timeout");
            return;
          }
          const bytes = Buffer.from(random(32));
          if (bytes.byteLength !== 32) {
            closeConnection(connection, 1011, "heartbeat_unavailable");
            return;
          }
          const nonce = bytes.toString("base64url");
          bytes.fill(0);
          connection.pendingPings.add(nonce);
          sendJson(socket, { type: "ping", nonce });
        }, HEARTBEAT_INTERVAL_MS);
        connection.heartbeatTimer.unref?.();
        return;
      }
      if (
        message.type === "pong" &&
        connection.pendingPings.has(message.nonce)
      ) {
        connection.pendingPings.clear();
        connection.lastPongAtMs = monotonicTime(monotonicNow);
        return;
      }
      if (message.type === "ping") {
        sendJson(socket, { type: "pong", nonce: message.nonce });
        return;
      }
      if (message.type === "helper_control") {
        if (!connection.negotiatedCapabilities.has("helper-pause-v1")) {
          closeConnection(connection, 1008, "capability_not_negotiated");
          return;
        }
        const paused = message.action === "pause";
        try {
          const state = registry.setHelperPaused(session.ownerId, paused);
          if (state?.paused !== paused)
            throw gatewayError("helper_state_unavailable");
          if (paused && connection.activeStream) {
            const activeStream = connection.activeStream;
            const pendingError = activeStream.openSettled
              ? null
              : gatewayError("helper_paused");
            clearStream(connection, activeStream, pendingError, true, "paused");
          }
          if (paused && connection.pendingLaunch)
            finishLaunch(connection, connection.pendingLaunch, {
              status: "unavailable",
            });
          sendJson(socket, {
            type: "helper_control_result",
            requestId: message.requestId,
            paused: registry.getHelperPaused(session.ownerId),
          });
        } catch {
          closeConnection(connection, 1011, "helper_control_unavailable");
        }
        return;
      }
      if (message.type === "game_launch_result") {
        const pending = connection.pendingLaunch;
        if (
          pending &&
          message.requestId !== pending.requestId &&
          connection.ignoredLaunchRequestIds.delete(message.requestId)
        )
          return;
        if (!pending) {
          if (connection.ignoredLaunchRequestIds.delete(message.requestId))
            return;
          closeConnection(connection, 1008, "unmatched_game_launch_result");
          return;
        }
        if (
          message.requestId !== pending.requestId ||
          message.operationId !== pending.operationId ||
          message.consentGeneration !== pending.consentGeneration
        ) {
          closeConnection(connection, 1008, "game_launch_correlation_invalid");
          return;
        }
        finishLaunch(
          connection,
          pending,
          pending.cancelled ? { status: "cancelled" } : message,
        );
        return;
      }
      const stream = connection.activeStream;
      if (
        message.type === "stream_ready" &&
        stream &&
        message.requestId === stream.requestId &&
        message.streamId === stream.streamId
      ) {
        stream.desktopReady = true;
        maybeResolveStream(connection, stream);
        return;
      }
      if (
        message.type === "stream_failed" &&
        stream &&
        message.requestId === stream.requestId &&
        message.streamId === stream.streamId
      ) {
        failStream(connection, stream, message.transportError);
        return;
      }
      if (
        message.type === "close_stream" &&
        stream &&
        message.streamId === stream.streamId
      ) {
        clearStream(connection, stream, null, false);
        return;
      }
      closeConnection(connection, 1008, "unsupported_control_message");
    });
    socket.once("close", () => cleanupConnection(connection));
    socket.once("error", () =>
      closeConnection(connection, 1011, "socket_error"),
    );
  }

  async function authorizeCredential(request, requiredScope) {
    const credential = bearerCredential(request.headers.authorization);
    if (!credential) return null;
    let session;
    try {
      session = await registry.authorizeDeviceSession(credential);
    } catch {
      return null;
    }
    if (!validSession(session, requiredScope)) return null;
    return { credential, session };
  }

  async function handleControlUpgrade(request, socket, head) {
    const authenticated = await authorizeCredential(request, "control");
    if (socket.destroyed || socket.writableEnded) return false;
    if (!authenticated) {
      response(socket, 401, "Unauthorized");
      return false;
    }
    if (draining || closed) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    const { credential, session } = authenticated;
    if (connections.has(session.deviceId)) {
      response(socket, 409, "Conflict");
      return false;
    }
    if (connections.size >= maxControlConnections) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      acceptConnection(webSocket, session, credential);
    });
    return true;
  }

  async function handleDataUpgrade(request, socket, head) {
    if (draining || closed) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    if (!ticketRegistry) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    const authenticated = await authorizeCredential(request, "data");
    if (socket.destroyed || socket.writableEnded) return false;
    if (!authenticated) {
      response(socket, 401, "Unauthorized");
      return false;
    }
    const ticket = request.headers["x-madhouse-stream-ticket"];
    if (typeof ticket !== "string" || ticket.length > 512) {
      response(socket, 401, "Unauthorized");
      return false;
    }
    let claims;
    try {
      claims = await ticketRegistry.consume(ticket, authenticated.session);
    } catch {
      if (socket.destroyed || socket.writableEnded) return false;
      response(socket, 401, "Unauthorized");
      return false;
    }
    if (socket.destroyed || socket.writableEnded) return false;
    const connection = connections.get(authenticated.session.deviceId);
    const stream = connection?.activeStream;
    if (
      !connection ||
      draining ||
      closed ||
      !connection.ready ||
      !sameSession(connection.session, authenticated.session) ||
      claims.connectionId !== connection.session.connectionId ||
      !stream ||
      stream.ticketId !== claims.ticketId ||
      stream.streamId !== claims.streamId ||
      stream.routeEpoch !== claims.routeEpoch ||
      stream.dataSocket
    ) {
      response(socket, 401, "Unauthorized");
      return false;
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      acceptDataSocket(webSocket, connection, stream);
    });
    return true;
  }

  async function handleUpgrade(request, socket, head) {
    if (draining || closed) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    if (!enabled) {
      response(socket, 404, "Not Found");
      return false;
    }
    let url;
    try {
      url = new URL(request.url || "/", "https://bridge.invalid");
    } catch {
      response(socket, 400, "Bad Request");
      return false;
    }
    if (
      request.method !== "GET" ||
      ![CONTROL_PATH, DATA_PATH].includes(url.pathname) ||
      url.search ||
      url.hash
    ) {
      response(socket, 404, "Not Found");
      return false;
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== allowedOrigin) {
      response(socket, 403, "Forbidden");
      return false;
    }
    if (pendingUpgrades >= maxPendingUpgrades) {
      response(socket, 503, "Service Unavailable");
      return false;
    }
    pendingUpgrades += 1;
    const timeout = setTimeout(() => {
      if (!socket.destroyed && !socket.writableEnded)
        response(socket, 503, "Service Unavailable");
    }, upgradeTimeoutMs);
    timeout.unref();
    try {
      return await (url.pathname === CONTROL_PATH
        ? handleControlUpgrade(request, socket, head)
        : handleDataUpgrade(request, socket, head));
    } finally {
      clearTimeout(timeout);
      pendingUpgrades -= 1;
    }
  }

  async function openStream({ ownerId, deviceId, routeEpoch, signal } = {}) {
    if (!enabled || draining || closed || !ticketRegistry)
      throw gatewayError("bridge_offline");
    if (
      typeof ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
      !isUuid(deviceId) ||
      !Number.isSafeInteger(routeEpoch) ||
      routeEpoch < 1
    )
      throw gatewayError("invalid_stream_route");
    try {
      if (registry.getHelperPaused(ownerId))
        throw gatewayError("helper_paused");
    } catch (error) {
      if (error?.code === "helper_paused") throw error;
      throw gatewayError("helper_state_unavailable");
    }
    if (
      signal &&
      (typeof signal.addEventListener !== "function" || signal.aborted)
    )
      throw gatewayError("bridge_offline");
    const connection = connections.get(deviceId);
    if (
      !connection ||
      !connection.ready ||
      connection.socket.readyState !== WebSocket.OPEN
    )
      throw gatewayError("bridge_offline");
    if (connection.activeStream) throw gatewayError("stream_limit");
    let currentSession;
    try {
      currentSession = await registry.authorizeDeviceSession(
        connection.credential,
      );
    } catch {
      closeConnection(connection, 4004, "route_changed");
      throw gatewayError("route_stale");
    }
    if (
      !validSession(currentSession, "control") ||
      !currentSession.scopes.includes("data") ||
      !sameSession(connection.session, currentSession) ||
      currentSession.ownerId !== ownerId ||
      currentSession.deviceId !== deviceId ||
      currentSession.routeEpoch !== routeEpoch ||
      !currentSession.scopes.includes("data")
    ) {
      closeConnection(connection, 4004, "route_changed");
      throw gatewayError("route_stale");
    }
    const requestId = uuid();
    const streamId = uuid();
    if (!isUuid(requestId) || !isUuid(streamId))
      throw gatewayError("stream_id_unavailable");

    let resolveOpen;
    let rejectOpen;
    const opened = new Promise((resolve, reject) => {
      resolveOpen = resolve;
      rejectOpen = reject;
    });
    const stream = {
      requestId,
      streamId,
      routeEpoch,
      ticketId: null,
      dataSocket: null,
      duplex: null,
      desktopReady: false,
      openSettled: false,
      resolveOpen,
      rejectOpen,
      readyTimer: null,
      signal,
      abortHandler: null,
    };
    connection.activeStream = stream;
    if (signal) {
      stream.abortHandler = () => failStream(connection, stream, "cancelled");
      signal.addEventListener("abort", stream.abortHandler, { once: true });
    }
    stream.readyTimer = setTimeout(() => {
      failStream(connection, stream, "connect_timeout");
    }, streamReadyTimeoutMs);
    stream.readyTimer.unref?.();
    try {
      const { ticket, claims } = await ticketRegistry.issue({
        session: currentSession,
        streamId,
      });
      if (draining || closed || connection.activeStream !== stream)
        throw gatewayError("bridge_offline");
      if (registry.getHelperPaused(ownerId))
        throw gatewayError("helper_paused");
      stream.ticketId = claims.ticketId;
      sendJson(connection.socket, {
        type: "open_stream",
        requestId,
        streamId,
        target: "cargo-main",
        streamTicket: ticket,
        routeEpoch,
      });
    } catch (error) {
      clearStream(connection, stream, gatewayError("bridge_offline"), false);
      throw error;
    }
    return opened;
  }

  async function requestGameLaunch({
    ownerId,
    deviceId,
    operationId,
    consentGeneration,
    routeEpoch,
    signal,
    timeoutMs = GAME_LAUNCH_TIMEOUT_MS,
  } = {}) {
    if (!enabled || draining || closed) throw gatewayError("bridge_offline");
    if (
      typeof ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
      !isUuid(deviceId) ||
      !isUuid(operationId) ||
      !Number.isSafeInteger(consentGeneration) ||
      consentGeneration < 1 ||
      !Number.isSafeInteger(routeEpoch) ||
      routeEpoch < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 60_000
    )
      throw gatewayError("invalid_game_launch_request");
    if (signal && typeof signal.addEventListener !== "function")
      throw gatewayError("invalid_game_launch_signal");
    if (signal?.aborted) return { status: "cancelled" };
    try {
      if (registry.getHelperPaused(ownerId)) return { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
    const connection = connections.get(deviceId);
    if (
      !connection ||
      !connection.ready ||
      connection.socket.readyState !== WebSocket.OPEN ||
      connection.session.ownerId !== ownerId ||
      connection.session.routeEpoch !== routeEpoch ||
      !connection.negotiatedCapabilities.has("official-game-launch-v1")
    )
      return { status: "unavailable" };
    if (connection.pendingLaunch) throw gatewayError("game_auth_busy");

    let currentSession;
    try {
      currentSession = await registry.authorizeDeviceSession(
        connection.credential,
      );
    } catch {
      closeConnection(connection, 4004, "route_changed");
      return { status: "unavailable" };
    }
    if (
      !validSession(currentSession, "control") ||
      draining ||
      closed ||
      !sameSession(connection.session, currentSession) ||
      currentSession.ownerId !== ownerId ||
      currentSession.deviceId !== deviceId ||
      currentSession.routeEpoch !== routeEpoch
    ) {
      closeConnection(connection, 4004, "route_changed");
      return { status: "unavailable" };
    }
    try {
      if (registry.getHelperPaused(ownerId)) return { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }

    const requestId = uuid();
    if (!isUuid(requestId)) throw gatewayError("game_auth_unavailable");
    let resolve;
    const result = new Promise((resolveResult) => {
      resolve = resolveResult;
    });
    const pending = {
      requestId,
      operationId,
      consentGeneration,
      resolve,
      settled: false,
      cancelled: false,
      timer: null,
      signal,
      abortHandler: null,
    };
    connection.pendingLaunch = pending;
    pending.timer = setTimeout(() => {
      rememberIgnoredLaunch(connection, requestId);
      finishLaunch(connection, pending, { status: "unavailable" });
    }, timeoutMs);
    pending.timer.unref?.();
    if (signal) {
      pending.abortHandler = () => {
        pending.cancelled = true;
        finishLaunch(
          connection,
          pending,
          { status: "cancelled" },
          { retainPending: true },
        );
      };
      signal.addEventListener("abort", pending.abortHandler, { once: true });
      if (signal.aborted) pending.abortHandler();
    }
    try {
      if (
        !sendJson(connection.socket, {
          type: "request_game_launch",
          requestId,
          operationId,
          consentGeneration,
          purpose: "official-game-auth",
        })
      )
        finishLaunch(connection, pending, { status: "unavailable" });
    } catch {
      finishLaunch(connection, pending, { status: "unavailable" });
    }
    return result;
  }

  function closeDevice(deviceId, deviceGeneration, reason = "device_revoked") {
    const connection = connections.get(deviceId);
    if (
      connection &&
      (deviceGeneration === undefined ||
        deviceGeneration >= connection.session.deviceGeneration)
    ) {
      const routeChanged = reason === "route_changed";
      closeConnection(
        connection,
        routeChanged ? 4004 : 4003,
        routeChanged ? "route_changed" : "device_revoked",
      );
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const connection of connections.values())
      closeConnection(connection, 1001, "server_shutdown");
    ticketRegistry?.clear();
    server.close();
  }

  function drain({ deadlineInMs = 35_000 } = {}) {
    if (
      !Number.isSafeInteger(deadlineInMs) ||
      deadlineInMs < 1 ||
      deadlineInMs > 35_000
    )
      throw new RangeError("bridge_drain_deadline_invalid");
    if (drainFlight) return drainFlight;
    if (closed) return Promise.resolve(true);
    draining = true;
    const drainId = uuid();
    if (!isUuid(drainId)) throw gatewayError("bridge_drain_id_unavailable");
    for (const connection of connections.values()) {
      if (!connection.ready) {
        closeConnection(connection, 1001, "server_shutdown");
        continue;
      }
      sendJson(connection.socket, {
        type: "drain",
        drainId,
        routeEpoch: connection.session.routeEpoch,
        deadlineInMs,
      });
    }
    drainFlight = waitForIdle(deadlineInMs).then((idle) => {
      close();
      return idle;
    });
    return drainFlight;
  }

  return Object.freeze({
    handleUpgrade,
    openStream,
    requestGameLaunch,
    closeDevice,
    drain,
    close,
    get activeConnectionCount() {
      return connections.size;
    },
    get activeStreamCount() {
      let count = 0;
      for (const connection of connections.values())
        if (connection.activeStream) count += 1;
      return count;
    },
    get activeGameLaunchCount() {
      let count = 0;
      for (const connection of connections.values())
        if (connection.pendingLaunch) count += 1;
      return count;
    },
  });
}
