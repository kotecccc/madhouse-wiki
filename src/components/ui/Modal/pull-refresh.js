import { isPullReady } from "../../../app/App/pull-refresh.js";

const cooldowns = new Map();
const running = new Set();
const INTERVAL_MS = 10000;

export function createModalRefreshGate({
  now = Date.now,
  interval = INTERVAL_MS,
} = {}) {
  return async (key, refresh) => {
    const at = now();
    if (
      running.has(key) ||
      (cooldowns.has(key) && at - cooldowns.get(key) < interval)
    )
      return false;
    cooldowns.set(key, at);
    running.add(key);
    try {
      await refresh();
      return true;
    } finally {
      running.delete(key);
    }
  };
}
export const refreshModal = createModalRefreshGate();
export { isPullReady };
