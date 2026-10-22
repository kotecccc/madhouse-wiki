import assert from "node:assert/strict";
import test from "node:test";
import { createWikiAnalyticsApi } from "../scripts/analytics/wiki-analytics-api.mjs";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";

async function invoke(handler, request) {
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = Buffer.from(body).toString("utf8");
    },
  };
  await handler(request, response);
  return { ...response, json: JSON.parse(response.body) };
}

function analyticsHandler() {
  const api = createWikiAnalyticsApi({
    botToken: "test-bot-token",
    adminTelegramId: "12345",
    store: { async append() {} },
  });
  return createWikiApiVercelHandler(api);
}

test("handler reads streamed JSON when the serverless body parser is disabled", async () => {
  const request = {
    method: "POST",
    url: "/api/analytics",
    headers: { "content-type": "application/json" },
    body: undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(
        '{"action":"events","visitorId":"00000000-0000-4000-8000-000000000001",',
      );
      yield Buffer.from('"events":[{"event":"app_open"}]}');
    },
  };
  const response = await invoke(analyticsHandler(), request);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json, { accepted: 1 });
  assert.equal(
    response.headers["cache-control"],
    "private, no-store, max-age=0",
  );
});

test("handler rejects streamed bodies over 3 MiB", async () => {
  let apiCalled = false;
  const handler = createWikiApiVercelHandler(async () => {
    apiCalled = true;
    return Response.json({ ok: true });
  });
  const response = await invoke(handler, {
    method: "POST",
    url: "/api/analytics",
    headers: { "content-type": "application/json" },
    body: undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(3 * 1024 * 1024);
      yield Buffer.from("x");
    },
  });
  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json, { error: "payload_too_large" });
  assert.equal(apiCalled, false);
});

test("GET does not consume a request iterator or attach a body", async () => {
  let consumed = false;
  let sawBody = false;
  const handler = createWikiApiVercelHandler(async (request) => {
    sawBody = request.body !== null;
    return Response.json({ ok: true });
  });
  const response = await invoke(handler, {
    method: "GET",
    url: "/api/analytics",
    headers: {},
    body: undefined,
    async *[Symbol.asyncIterator]() {
      consumed = true;
      yield Buffer.from("not a body");
    },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(consumed, false);
  assert.equal(sawBody, false);
});

test("malformed streamed JSON reaches the API and is rejected as invalid_request", async () => {
  const request = {
    method: "POST",
    url: "/api/analytics",
    headers: { "content-type": "application/json" },
    body: undefined,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"action":');
    },
  };
  const response = await invoke(analyticsHandler(), request);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, { error: "invalid_request" });
});
