import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeDeviceClient } from "../shared/bridge-device-api.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("session renewal sends only the existing session as authorization", async () => {
  let sent;
  const client = createBridgeDeviceClient({
    getInitData: () => "",
    fetcher: async (_url, init) => {
      sent = init;
      return json({ session: "next.payload.signature" });
    },
  });
  assert.equal(
    await client.renew("Bearer header.payload.signature"),
    "next.payload.signature",
  );
  assert.deepEqual(JSON.parse(sent.body), { operation: "renew" });
  assert.equal(sent.headers.Authorization, "Bearer header.payload.signature");
  await assert.rejects(client.renew("Bearer invalid"), {
    code: "not_authorized",
  });
});

test("bridge session is requested with Telegram identity and validated", async () => {
  let sent;
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async (_url, init) => {
      sent = JSON.parse(init.body);
      return json({ session: "header.payload.signature" });
    },
  });
  assert.equal(await client.session(), "header.payload.signature");
  assert.deepEqual(sent, { operation: "session", initData: "signed-data" });
  const bad = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => json({ session: "not-jwt" }),
  });
  await assert.rejects(bad.session(), { code: "bridge_unavailable" });
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
  code = "device_offline";
  await assert.rejects(client.profile(), { code: "device_offline" });
  code = "profile_unavailable";
  await assert.rejects(client.profile(), { code: "profile_unavailable" });
});

test("a network failure does not claim the device is offline or expose the error", async () => {
  const client = createBridgeDeviceClient({
    getInitData: () => "signed-data",
    fetcher: async () => {
      throw new Error("private-network-details");
    },
  });
  await assert.rejects(client.status(), {
    code: "wiki_unreachable",
    message: "wiki_unreachable",
  });
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
