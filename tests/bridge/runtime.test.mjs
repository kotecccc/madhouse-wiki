import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeRuntime } from "../../scripts/bridge/runtime.mjs";

const now = 1_800_000_000_000;
const origin = "https://wiki.example";
const botToken = "synthetic-bot";
function initData() {
  const data = new URLSearchParams({
    auth_date: String(now / 1000),
    user: JSON.stringify({ id: 101 }),
  });
  const text = [...data.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  data.set("hash", createHmac("sha256", key).update(text).digest("hex"));
  return data.toString();
}
function request(path, body) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

test("isolated runtime preserves device binding across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-runtime-"));
  const options = {
    directory: dir,
    botToken,
    origin,
    now: () => now,
    consume: () => true,
  };
  let runtime;
  try {
    runtime = createBridgeRuntime(options);
    const send = (path, body) =>
      runtime.handle(request(path, body), "127.0.0.1");
    const issued = await (
      await send("/api/bridge/device", {
        initData: initData(),
        operation: "invite",
      })
    ).json();
    const paired = await (
      await send("/api/bridge/redeem", { invitation: issued.invitation })
    ).json();
    runtime.close();
    runtime = createBridgeRuntime(options);
    const list = await (
      await send("/api/bridge/device", {
        initData: initData(),
        operation: "list",
      })
    ).json();
    assert.equal(list.device.deviceId, paired.deviceId);
    const status = await (
      await send("/api/bridge/device", {
        initData: initData(),
        operation: "status",
      })
    ).json();
    assert.deepEqual(status, { device: "offline", account: "not_configured" });
    runtime.close();
    runtime.close();
  } finally {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime cannot start without an explicit limiter", () => {
  assert.throws(() => createBridgeRuntime({}), {
    message: "bridge_rate_limiter_required",
  });
});
