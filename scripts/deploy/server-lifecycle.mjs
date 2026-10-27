const DEFAULT_DRAIN_DEADLINE_MS = 35_000;

export function installServerLifecycle({
  server,
  runtime = null,
  httpSockets = new Set(),
  upgradedSockets = new Set(),
  signalTarget = process,
  deadlineInMs = DEFAULT_DRAIN_DEADLINE_MS,
} = {}) {
  if (
    !server ||
    typeof server.close !== "function" ||
    typeof signalTarget?.on !== "function"
  )
    throw new TypeError("server_lifecycle_dependencies_invalid");
  if (
    !Number.isSafeInteger(deadlineInMs) ||
    deadlineInMs < 1 ||
    deadlineInMs > DEFAULT_DRAIN_DEADLINE_MS
  )
    throw new RangeError("server_lifecycle_deadline_invalid");

  let state = "running";
  let shutdownFlight = null;
  let forceDeadline = null;

  function forceCloseSockets() {
    try {
      server.closeAllConnections?.();
    } catch {
      // Socket registries below are the portable fallback.
    }
    for (const socket of new Set([...httpSockets, ...upgradedSockets])) {
      try {
        socket.destroy();
      } catch {
        // A socket may have closed between the snapshot and destroy call.
      }
    }
  }

  function shutdown() {
    if (shutdownFlight) return shutdownFlight;
    state = "draining";

    let resolveDeadline;
    const deadline = new Promise((resolve) => {
      resolveDeadline = resolve;
    });
    forceDeadline = () => resolveDeadline(false);
    const deadlineTimer = setTimeout(
      () => resolveDeadline(false),
      deadlineInMs,
    );

    const serverClosed = new Promise((resolve) => {
      if (server.listening === false) {
        resolve(true);
        return;
      }
      try {
        server.close((error) => resolve(!error));
        server.closeIdleConnections?.();
      } catch {
        resolve(false);
      }
    });

    let runtimeDrain;
    try {
      runtimeDrain = Promise.resolve(
        runtime?.drain?.({ deadlineInMs }) ?? true,
      ).catch(() => false);
    } catch {
      runtimeDrain = Promise.resolve(false);
    }

    shutdownFlight = Promise.race([
      Promise.all([serverClosed, runtimeDrain]).then(
        ([httpClosed, runtimeDrained]) => httpClosed && runtimeDrained,
      ),
      deadline,
    ]).then((drained) => {
      clearTimeout(deadlineTimer);
      forceDeadline = null;
      let completed = drained;
      try {
        runtime?.close?.();
      } catch {
        completed = false;
      } finally {
        forceCloseSockets();
        state = "closed";
      }
      return completed;
    });
    return shutdownFlight;
  }

  function handleSignal() {
    if (state === "running") void shutdown();
    else if (state === "draining") forceDeadline?.();
  }

  signalTarget.on("SIGTERM", handleSignal);
  signalTarget.on("SIGINT", handleSignal);

  return Object.freeze({
    shutdown,
    get state() {
      return state;
    },
  });
}
