const RETRY_DURATION_MS = 60_000;

export function retrySeconds(until, now = Date.now()) {
  if (!Number.isFinite(until) || !Number.isFinite(now)) return 0;
  return Math.min(60, Math.max(0, Math.ceil((until - now) / 1000)));
}

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRetryStartedAt(key, storage, now = Date.now()) {
  const target = resolveStorage(storage);
  if (!target || typeof key !== "string" || !key || !Number.isFinite(now))
    return 0;

  try {
    const raw = target.getItem(key);
    if (raw === null) return 0;
    const startedAt = Number(raw);
    if (
      !Number.isFinite(startedAt) ||
      !Number.isInteger(startedAt) ||
      startedAt <= 0 ||
      startedAt > now
    ) {
      target.removeItem(key);
      return 0;
    }
    if (now - startedAt > RETRY_DURATION_MS) {
      target.removeItem(key);
      return 0;
    }
    return startedAt;
  } catch {
    return 0;
  }
}

export function writeRetryStartedAt(key, start, storage) {
  const target = resolveStorage(storage);
  if (
    !target ||
    typeof key !== "string" ||
    !key ||
    !Number.isFinite(start) ||
    !Number.isInteger(start) ||
    start <= 0
  )
    return false;
  try {
    target.setItem(key, String(start));
    return true;
  } catch {
    return false;
  }
}
