import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBridgeBrowserSessions,
  resolveBridgeBrowserSession,
} from "../../scripts/bridge/browser-session.mjs";

test("browser session stops resolving after rebind or device replacement", () => {
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 7),
    now: () => 1000000,
  });
  const token = sessions.issue("101", 3, { deviceId: "device", generation: 1 });
  assert.equal(sessions.isBridgeToken(token), true);
  assert.equal(sessions.isBridgeToken("other.jwt.token"), false);
  let account = {
    revision: 3,
    deviceId: "device",
    generation: 1,
    authorization: "Bearer private",
  };
  let device = { deviceId: "device", generation: 1 };
  const deps = {
    sessions,
    accounts: { read: () => account },
    devices: { listDevice: () => device },
  };
  assert.equal(
    resolveBridgeBrowserSession(token, deps).authorization,
    "Bearer private",
  );
  account = { ...account, revision: 4 };
  assert.equal(resolveBridgeBrowserSession(token, deps), null);
  account = { ...account, revision: 3 };
  device = { ...device, generation: 2 };
  assert.equal(resolveBridgeBrowserSession(token, deps), null);
  device = null;
  assert.equal(resolveBridgeBrowserSession(token, deps), null);
});

test("bridge browser session is signed, scoped and expires", () => {
  let now = 1_000_000;
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 9),
    now: () => now,
  });
  const token = sessions.issue("101", 3, { deviceId: "device", generation: 1 });
  assert.deepEqual(sessions.verify(token), {
    owner: "101",
    revision: 3,
    deviceId: "device",
    generation: 1,
    until: 87400,
  });
  assert.equal(
    sessions.verify(token.replace(/.$/, token.endsWith("A") ? "B" : "A")),
    null,
  );
  assert.equal(
    createBridgeBrowserSessions({
      key: Buffer.alloc(32, 8),
      now: () => now,
    }).verify(token),
    null,
  );
  now += 900_000;
  assert.equal(sessions.verify(token), null);
});

test("renewed session cannot outlive the original absolute limit", () => {
  let now = 1_000_000;
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 4),
    now: () => now,
  });
  const device = { deviceId: "device", generation: 1 };
  const first = sessions.verify(sessions.issue("101", 1, device));
  now += 600_000;
  const renewed = sessions.verify(
    sessions.issue("101", 1, device, first.until),
  );
  assert.equal(renewed.until, first.until);
  now = first.until * 1000;
  assert.throws(
    () => sessions.issue("101", 1, device, first.until),
    /invalid_session_owner/,
  );
});
