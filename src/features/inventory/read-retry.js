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
      data = result;
      onData(result);
      if (!isFailedResponse(result))
        return { status: "ready", data, attempts: attempt };
    } catch {
      // Retry only reads; callers never pass mutation commands here.
    }
    if (attempt < maxAttempts && !(await wait(intervalMs, signal)))
      return { status: "cancelled", data, attempts: attempt };
  }
  return { status: "error", data, attempts: maxAttempts };
}
