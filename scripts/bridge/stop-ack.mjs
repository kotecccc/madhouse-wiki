import { randomBytes } from "node:crypto";

const STOP_CODE = 4001;
const pending = new WeakMap();

// A positive acknowledgement proves only that the authenticated relay has
// stopped writing to this tunnel. It does not establish a game outcome or
// retract bytes already accepted by TCP. This helper is not an admission gate.
export function requestRelayStopAck(
  socket,
  {
    nonce = () => randomBytes(16).toString("hex"),
    // The Python relay permits up to three seconds for its worker to stop.
    timeoutMs = 5000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  if (
    !socket ||
    socket.bridgeStopAck !== true ||
    socket.readyState !== 1 ||
    typeof socket.close !== "function" ||
    typeof socket.once !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    return Promise.resolve(false);
  if (pending.has(socket)) return pending.get(socket);
  const token = nonce();
  if (typeof token !== "string" || !/^[a-f0-9]{32}$/.test(token))
    throw new TypeError("invalid_stop_challenge");
  const reason = `stop:${token}`;
  const promise = new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
      pending.delete(socket);
      resolve(value);
    };
    const onClose = (code, received) =>
      finish(
        code === STOP_CODE &&
          Buffer.from(received || "").toString("utf8") === reason,
      );
    const onError = () => finish(false);
    socket.once("close", onClose);
    socket.once("error", onError);
    timer = setTimer(() => finish(false), timeoutMs);
    try {
      socket.close(STOP_CODE, reason);
    } catch {
      finish(false);
    }
  });
  pending.set(socket, promise);
  void promise.then(() => {
    if (pending.get(socket) === promise) pending.delete(socket);
  });
  return promise;
}
