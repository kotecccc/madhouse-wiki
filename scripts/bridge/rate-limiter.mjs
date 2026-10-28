import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";

const limits = Object.freeze({
  "/api/bridge/device": [30, 60_000],
  "/api/bridge/redeem": [12, 60_000],
  "/bridge/data": [30, 60_000],
});

/** Process-local protection; deployment must also configure ingress limits. */
export function createBridgeRateLimiter({
  now = () => performance.now(),
  capacity = 4096,
} = {}) {
  if (
    typeof now !== "function" ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1
  )
    throw new TypeError("invalid_bridge_rate_limiter");
  const key = randomBytes(32);
  const buckets = new Map();
  let lastTime = 0;
  function consume(ip, route) {
    if (typeof ip !== "string" || !isIP(ip) || !Object.hasOwn(limits, route))
      return false;
    const time = now();
    if (!Number.isFinite(time) || time < lastTime || time < 0) return false;
    lastTime = time;
    const [limit, windowMs] = limits[route];
    const opaque = createHmac("sha256", key)
      .update(ip)
      .update("\0")
      .update(route)
      .digest("hex");
    let bucket = buckets.get(opaque);
    if (bucket && time >= bucket.expires) {
      buckets.delete(opaque);
      bucket = null;
    }
    if (!bucket) {
      if (buckets.size >= capacity) {
        for (const [id, item] of buckets)
          if (time >= item.expires) buckets.delete(id);
        if (buckets.size >= capacity) return false;
      }
      bucket = { count: 0, expires: time + windowMs };
      buckets.set(opaque, bucket);
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }
  return Object.freeze({ consume });
}
