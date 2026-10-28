import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeDeviceClient } from "../shared/bridge-device-api.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("client sends secrets only in same-origin no-store body", async () => {
  let sent;
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async (url, init) => {
      sent = { url, init };
      return json({ status: "connected" });
    },
  });
  assert.deepEqual(await client.bind("fake-token"), { status: "connected" });
  assert.equal(sent.url, "/api/bridge/device");
  assert.deepEqual(JSON.parse(sent.init.body), {
    operation: "bind",
    initData: "signed-data",
    accessToken: "fake-token",
  });
  assert.equal(sent.init.redirect, "error");
  assert.equal(sent.init.cache, "no-store");
  assert.equal(sent.init.credentials, "same-origin");
});

test("client separates device and account status and rejects malformed values", async () => {
  let response = { device: "online", account: "saved" };
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => json(response),
  });
  assert.deepEqual(await client.status(), response);
  response = { device: "online", account: "valid" };
  await assert.rejects(client.status(), { code: "bridge_unavailable" });
});

test("invalid input, missing identity and unknown server errors fail without exposing data", async () => {
  let calls = 0;
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => {
      calls += 1;
      return json({ error: "secret-error" }, 500);
    },
  });
  await assert.rejects(client.bind("bad token"), {
    code: "invalid_game_token",
  });
  assert.equal(calls, 0);
  await assert.rejects(client.status(), { code: "bridge_unavailable" });
  const noUser = createBridgeDeviceClient({
    getInitData: () => "",
    fetcher: async () => assert.fail("unexpected fetch"),
  });
  await assert.rejects(noUser.status(), { code: "not_authorized" });
});

test("profile verification preserves expired-token and offline errors", async () => {
  let code = "invalid_game_token";
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => json({ error: code }, 409),
  });
  await assert.rejects(client.profile(), { code: "invalid_game_token" });
  code = "bridge_unavailable";
  await assert.rejects(client.profile(), { code: "bridge_unavailable" });
});

test("binding reports a pending direct request distinctly", async () => {
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => json({ error: "direct_requests_in_flight" }, 409),
  });
  await assert.rejects(client.bind("synthetic-token"), {
    code: "direct_requests_in_flight",
  });
});
