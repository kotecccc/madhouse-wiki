import { WebSocketDuplex } from "./websocket-duplex.mjs";

function error(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Owns one authenticated connection per account. Admission/authentication are
 * supplied by the registry; this class never infers an owner from client input.
 * A connection is consumed once, and is never used to replay a request.
 */
export function createDeviceTunnelPool({
  authorize,
  reauthorizeMs = 1000,
  reconnectWaitMs = 18000,
} = {}) {
  if (
    typeof authorize !== "function" ||
    !Number.isSafeInteger(reauthorizeMs) ||
    reauthorizeMs < 10 ||
    !Number.isSafeInteger(reconnectWaitMs) ||
    reconnectWaitMs < 0 ||
    reconnectWaitMs > 18000
  )
    throw new TypeError("authorize_required");
  const connections = new Map();
  const revisions = new Map();
  const waiters = new Map();
  const reconnecting = new Map();
  let stopped = false;

  function notify(owner) {
    for (const wake of waiters.get(owner) || []) wake();
  }

  function expectReconnect(owner) {
    const previous = reconnecting.get(owner);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      if (reconnecting.get(owner) === timer) reconnecting.delete(owner);
      notify(owner);
    }, reconnectWaitMs);
    timer.unref?.();
    reconnecting.set(owner, timer);
  }

  function waitForChange(owner, remaining, signal) {
    let ownerWaiters = waiters.get(owner);
    if (!ownerWaiters) waiters.set(owner, (ownerWaiters = new Set()));
    if (ownerWaiters.size >= 16) throw error("bridge_offline");
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", wake);
        ownerWaiters.delete(wake);
        if (!ownerWaiters.size) waiters.delete(owner);
        resolve();
      };
      ownerWaiters.add(wake);
      timer = setTimeout(wake, remaining);
      signal?.addEventListener("abort", wake, { once: true });
      if (signal?.aborted) wake();
    });
  }

  async function admit(identity, socket) {
    if (
      stopped ||
      !identity ||
      typeof identity.owner !== "string" ||
      typeof identity.device !== "string" ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1 ||
      !socket ||
      socket.readyState !== 1 ||
      typeof socket.terminate !== "function"
    ) {
      socket?.terminate?.();
      throw error("bridge_unavailable");
    }
    // Capture the trusted identity before awaiting external authorization.
    identity = Object.freeze({
      owner: identity.owner,
      device: identity.device,
      generation: identity.generation,
    });
    // A revoke during async admission invalidates even a stale authorization result.
    const revision = revisions.get(identity.owner) || 0;
    const authorized = await Promise.resolve()
      .then(() => authorize(identity))
      .catch(() => false);
    // A consumed WebSocket can still be completing its close handshake when
    // the same device reconnects. It cannot carry another request once it is
    // closing, so it must not reject the authenticated replacement.
    const previous = connections.get(identity.owner);
    if (
      authorized === true &&
      !stopped &&
      revision === (revisions.get(identity.owner) || 0) &&
      socket.readyState === 1 &&
      previous &&
      previous.socket.readyState > 1
    ) {
      connections.delete(identity.owner);
      clearInterval(previous.timer);
      previous.socket.terminate();
    }
    if (
      authorized !== true ||
      stopped ||
      revision !== (revisions.get(identity.owner) || 0) ||
      socket.readyState !== 1 ||
      connections.has(identity.owner)
    ) {
      socket.terminate();
      throw error("bridge_unavailable");
    }
    const record = { identity: { ...identity }, socket, state: "idle" };
    connections.set(identity.owner, record);
    const reconnectTimer = reconnecting.get(identity.owner);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnecting.delete(identity.owner);
    notify(identity.owner);
    const remove = () => {
      clearInterval(record.timer);
      if (connections.get(identity.owner) === record) {
        connections.delete(identity.owner);
        if (!record.rejectReconnect && !stopped)
          expectReconnect(identity.owner);
        notify(identity.owner);
      }
    };
    socket.once("close", remove);
    socket.once("error", remove);
    // An idle agent must not inject bytes into a later TLS connection.
    const unexpected = () => {
      record.rejectReconnect = true;
      remove();
      socket.terminate();
    };
    socket.on("message", unexpected);
    record.removeIdleGuard = () => socket.off("message", unexpected);
    let checking = false;
    record.timer = setInterval(() => {
      if (checking) return;
      checking = true;
      Promise.resolve()
        .then(() => authorize(record.identity))
        .then(
          (active) => {
            if (active !== true && connections.get(identity.owner) === record)
              socket.terminate();
          },
          () => {
            if (connections.get(identity.owner) === record) socket.terminate();
          },
        )
        .finally(() => {
          checking = false;
        });
    }, reauthorizeMs);
    record.timer.unref?.();
  }

  async function open(owner, { signal } = {}) {
    const revision = revisions.get(owner) || 0;
    const deadline = Date.now() + reconnectWaitMs;
    let record;
    while (true) {
      if (
        stopped ||
        signal?.aborted ||
        revision !== (revisions.get(owner) || 0)
      )
        throw error("bridge_offline");
      record = connections.get(owner);
      if (record?.state === "idle") break;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || (!record && !reconnecting.has(owner)))
        throw error("bridge_offline");
      await waitForChange(owner, remaining, signal);
    }
    // Claim synchronously so concurrent requests cannot share the connection.
    record.state = "claimed";
    const authorized = await Promise.resolve()
      .then(() => authorize(record.identity))
      .catch(() => false);
    if (
      authorized !== true ||
      stopped ||
      signal?.aborted ||
      connections.get(owner) !== record ||
      record.socket.readyState !== 1
    ) {
      record.socket.terminate();
      throw error("bridge_offline");
    }
    record.removeIdleGuard();
    return new WebSocketDuplex(record.socket);
  }

  function revoke(owner, device) {
    revisions.set(owner, (revisions.get(owner) || 0) + 1);
    const reconnectTimer = reconnecting.get(owner);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnecting.delete(owner);
    notify(owner);
    const record = connections.get(owner);
    if (!record || record.identity.device !== device) return;
    connections.delete(owner);
    record.socket.terminate();
  }

  async function online(owner) {
    const record = connections.get(owner);
    if (!record || record.socket.readyState !== 1) return false;
    const active = await Promise.resolve()
      .then(() => authorize(record.identity))
      .catch(() => false);
    if (
      active !== true ||
      stopped ||
      connections.get(owner) !== record ||
      record.socket.readyState !== 1
    )
      return false;
    return true;
  }

  function close() {
    stopped = true;
    for (const timer of reconnecting.values()) clearTimeout(timer);
    reconnecting.clear();
    for (const owner of waiters.keys()) notify(owner);
    for (const { socket } of connections.values()) socket.terminate();
    connections.clear();
  }

  return Object.freeze({ admit, open, revoke, online, close });
}
