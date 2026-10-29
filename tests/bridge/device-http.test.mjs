import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBridgeDeviceHttp } from "../../scripts/bridge/device-http.mjs";
import { createDeviceRegistry } from "../../scripts/bridge/device-registry.mjs";
import { createBridgeDeviceService } from "../../scripts/bridge/device-service.mjs";
import { createBridgeBrowserSessions } from "../../scripts/bridge/browser-session.mjs";

const botToken = "fake-bot-token";
const origin = "https://wiki.example";
const now = 1_800_000_000_000;
function initData(id, age = 0) {
  const data = new URLSearchParams({
    auth_date: String(now / 1000 - age),
    user: JSON.stringify({ id }),
  });
  const check = [...data.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const key = createHmac("sha256", "WebAppData").update(botToken).digest();
  data.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return data.toString();
}
function request(path, body, requestOrigin = origin) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: requestOrigin },
    body: JSON.stringify(body),
  });
}

test("profile diagnostics expose only allowed error codes to the verified owner", async () => {
  let code = "device_offline";
  const handler = createBridgeDeviceHttp({
    service: {},
    accountService: {
      profile: async () => {
        throw Object.assign(new Error("private details"), { code });
      },
    },
    botToken,
    origin,
    now: () => now,
    consume: () => true,
  });
  const send = () =>
    handler(
      request("/api/bridge/device", {
        operation: "profile",
        initData: initData(101),
      }),
      "127.0.0.1",
    );
  let response = await send();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "device_offline" });
  code = "private-error";
  response = await send();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "bridge_unavailable" });
});

test("session renewal requires a current binding and preserves its deadline", async () => {
  let current = now;
  let device = { deviceId: "device", generation: 1 };
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 7),
    now: () => current,
  });
  const handler = createBridgeDeviceHttp({
    service: { listDevice: () => device },
    accounts: {
      read: () => ({ revision: 2, authorization: "Bearer private" }),
    },
    browserSessions: sessions,
    botToken,
    origin,
    now: () => current,
    consume: () => true,
  });
  const token = sessions.issue("101", 2, device);
  const send = () =>
    handler(
      new Request(`${origin}/api/bridge/device`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ operation: "renew" }),
      }),
      "127.0.0.1",
    );
  current += 600000;
  const renewed = await send();
  assert.equal(renewed.status, 200);
  assert.equal(
    sessions.verify((await renewed.json()).session).until,
    sessions.verify(token).until,
  );
  device = null;
  assert.equal((await send()).status, 401);
});

test("session issuance requires a verified owner and existing device binding", async () => {
  const handler = createBridgeDeviceHttp({
    service: {
      listDevice: (owner) =>
        owner === "101" ? { deviceId: "device", generation: 1 } : null,
    },
    accounts: { getRevision: (owner) => (owner === "101" ? 2 : 0) },
    browserSessions: {
      issue: (owner, revision, device) =>
        `${owner}-${revision}-${device.deviceId}`,
    },
    botToken,
    origin,
    now: () => now,
    consume: () => true,
  });
  const send = (id) =>
    handler(
      request("/api/bridge/device", {
        operation: "session",
        initData: initData(id),
      }),
      "127.0.0.1",
    );
  assert.deepEqual(await (await send(101)).json(), { session: "101-2-device" });
  assert.equal((await send(102)).status, 409);
  assert.equal(
    (
      await handler(
        request("/api/bridge/device", {
          operation: "session",
          initData: "invalid",
        }),
        "127.0.0.1",
      )
    ).status,
    401,
  );
});

test("verified Telegram owner pairs, lists and revokes only their device", async () => {
  const db = new DatabaseSync(":memory:");
  const registry = createDeviceRegistry({
    db,
    hmacKey: randomBytes(32),
    now: () => now,
  });
  const service = createBridgeDeviceService({ registry });
  const handler = createBridgeDeviceHttp({
    service,
    botToken,
    origin,
    now: () => now,
    consume: () => true,
  });
  try {
    const send = (path, data, source = origin) =>
      handler(request(path, data, source), "127.0.0.1");
    const invite = await (
      await send("/api/bridge/device", {
        operation: "invite",
        initData: initData(101),
      })
    ).json();
    const paired = await (
      await send("/api/bridge/redeem", { invitation: invite.invitation })
    ).json();
    assert.ok(paired.deviceKey);
    assert.equal(
      (await send("/api/bridge/redeem", { invitation: invite.invitation }))
        .status,
      409,
    );
    const stranger = await (
      await send("/api/bridge/device", {
        operation: "list",
        initData: initData(102),
      })
    ).json();
    assert.equal(stranger.device, null);
    const mine = await (
      await send("/api/bridge/device", {
        operation: "list",
        initData: initData(101),
      })
    ).json();
    assert.deepEqual(mine.device, { deviceId: paired.deviceId, generation: 1 });
    assert.equal(
      (
        await send("/api/bridge/device", {
          operation: "revoke",
          initData: initData(102),
          deviceId: paired.deviceId,
        })
      ).status,
      200,
    );
    assert.ok(registry.authenticateDevice(paired.deviceId, paired.deviceKey));
    assert.equal(
      (
        await send("/api/bridge/device", {
          operation: "revoke",
          initData: initData(101),
          deviceId: paired.deviceId,
        })
      ).status,
      200,
    );
    assert.equal(
      registry.authenticateDevice(paired.deviceId, paired.deviceKey),
      null,
    );
    assert.equal(
      (
        await send("/api/bridge/device", {
          operation: "invite",
          initData: initData(101, 301),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await send("/api/bridge/device", {
          operation: "invite",
          initData: initData(101) + "x",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await send(
          "/api/bridge/device",
          { operation: "invite", initData: initData(101) },
          "https://attacker.example",
        )
      ).status,
      403,
    );
  } finally {
    service.close();
    db.close();
  }
});

test("limiter and origin validation fail closed", async () => {
  assert.throws(
    () =>
      createBridgeDeviceHttp({
        service: {},
        botToken,
        origin: "http://wiki.example",
        consume: () => true,
      }),
    { message: "invalid_bridge_http_dependencies" },
  );
  const handler = createBridgeDeviceHttp({
    service: {},
    botToken,
    origin,
    consume: () => {
      throw new Error("unavailable");
    },
  });
  const result = await handler(
    request("/api/bridge/redeem", { invitation: "x" }),
    "127.0.0.1",
  );
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
});

test("a pending direct request produces a safe, actionable binding status", async () => {
  const handler = createBridgeDeviceHttp({
    service: {},
    botToken,
    origin,
    now: () => now,
    consume: () => true,
    accountService: {
      bind: async () => {
        throw Object.assign(new Error("private details"), {
          code: "direct_requests_in_flight",
        });
      },
    },
  });
  const result = await handler(
    request("/api/bridge/device", {
      operation: "bind",
      initData: initData(101),
      accessToken: "synthetic-token",
    }),
    "127.0.0.1",
  );
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "direct_requests_in_flight" });
});

test("game credential is accepted only from the verified owner and never returned", async () => {
  const seen = [];
  const handler = createBridgeDeviceHttp({
    service: {},
    botToken,
    origin,
    now: () => now,
    consume: () => true,
    accountService: {
      async bind(owner, token) {
        seen.push({ owner, token });
        return { status: "connected" };
      },
    },
  });
  const data = {
    operation: "bind",
    initData: initData(101),
    accessToken: "private-test-token",
  };
  const response = await handler(
    request("/api/bridge/device", data),
    "127.0.0.1",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"status":"connected"}');
  assert.deepEqual(seen, [
    { owner: "101", token: "Bearer private-test-token" },
  ]);
  const invalid = await handler(
    request("/api/bridge/device", { ...data, accessToken: "bad\r\nvalue" }),
    "127.0.0.1",
  );
  assert.equal(invalid.status, 400);
  assert.equal(seen.length, 1);
});
