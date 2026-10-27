export const INVENTORY_READ_MAX_ATTEMPTS = 3;
export const INVENTORY_READ_RETRY_INTERVAL_MS = 15000;

function waitForRetry(delayMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function runInventoryReadAttempts({
  read,
  onData = () => {},
  isFailedResponse = () => false,
  signal,
  wait = waitForRetry,
  maxAttempts = INVENTORY_READ_MAX_ATTEMPTS,
  intervalMs = INVENTORY_READ_RETRY_INTERVAL_MS,
}) {
  let data;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted)
      return { status: "cancelled", data, attempts: attempt - 1 };
    try {
      const result = await read(attempt, signal);
      if (signal?.aborted)
        return { status: "cancelled", data, attempts: attempt };
      data = result;
      onData(result);
      if (!isFailedResponse(result))
        return { status: "ready", data, attempts: attempt };
    } catch (error) {
      // Permanent request/auth failures need user action, not another request.
      if (Number.isFinite(error?.status) && error.status < 500)
        return { status: "error", data, attempts: attempt };
    }
    if (attempt < maxAttempts && !(await wait(intervalMs, signal)))
      return { status: "cancelled", data, attempts: attempt };
  }
  return { status: "error", data, attempts: maxAttempts };
}

// Show the saved snapshot first, then refresh it once when it is stale.
export async function readInventorySnapshot({ read, isFresh, onSnapshot }) {
  const snapshot = await read(false);
  if (isFresh()) return snapshot;
  onSnapshot(snapshot);
  return read(true);
}

// A fresh in-memory zone needs no request; otherwise let the server resolve its
// snapshot or refresh in one paced request instead of reading a stale snapshot first.
export function readTattooZone({ peekFresh, read }) {
  const cached = peekFresh();
  return cached != null ? Promise.resolve(cached) : read();
}
