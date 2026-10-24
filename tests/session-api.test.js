import test from "node:test";
import assert from "node:assert/strict";
import { createSessionApi } from "../shared/session-api.js";

test("session GET cache deduplicates, spaces requests, expires and clears between accounts", async () => {
  let clock = 0;
  let account = "fake-session-a";
  const starts = [];
  const api = createSessionApi({
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    authorize: (request) => ({
      ...request,
      headers: { Authorization: account },
    }),
    fetcher: async (url) => {
      starts.push([url, clock]);
      return { ok: true, json: async () => ({ account, url }) };
    },
  });
  const [one, duplicate, two] = await Promise.all([
    api.get("/api/me"),
    api.get("/api/me"),
    api.get("/api/floors"),
  ]);
  assert.deepEqual(one, duplicate);
  assert.equal(starts.length, 2);
  assert.equal(starts[1][1] - starts[0][1], 1100);
  await api.get("/api/me");
  assert.equal(starts.length, 2);
  clock += 180001;
  await api.get("/api/me");
  assert.equal(starts.length, 3);
  account = "fake-session-b";
  assert.equal((await api.get("/api/me")).account, account);
  assert.equal(starts.length, 4);
  assert.equal(two.url, "/api/floors");
  api.clear();
});

test("failed session requests are retryable and external URLs are rejected", async () => {
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async () => ({ ok: ++calls > 1, json: async () => [] }),
  });
  await assert.rejects(api.get("/api/floors"));
  assert.deepEqual(await api.get("/api/floors"), []);
  await assert.rejects(api.get("https://other.example/api/me"));
});

test("a switched session cannot receive a prior pending response or a cached response after expiry", async () => {
  let identity = "fake-a";
  let expired = false;
  let release;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => {
      if (expired) throw new Error("expired");
      return { ...request, headers: { Authorization: identity } };
    },
    fetcher: async () => {
      const accountAtStart = identity;
      if (identity === "fake-a")
        await new Promise((resolve) => {
          release = resolve;
        });
      return { ok: true, json: async () => ({ account: accountAtStart }) };
    },
  });
  const oldRequest = api.get("/api/me");
  const oldCheck = assert.rejects(oldRequest);
  await Promise.resolve();
  identity = "fake-b";
  const newRequest = api.get("/api/me");
  release();
  await oldCheck;
  assert.equal((await newRequest).account, "fake-b");
  expired = true;
  await assert.rejects(api.get("/api/me"), /expired/);
});

test("temporary GET failures recover within the shared request and cache only success", async () => {
  let calls = 0;
  const waits = [];
  const api = createSessionApi({
    interval: 0,
    pause: async (ms) => waits.push(ms),
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async () =>
      ++calls < 3
        ? new Response("", { status: 500 })
        : Response.json({ ready: true }),
  });
  const [one, two] = await Promise.all([
    api.get("/api/me"),
    api.get("/api/me"),
  ]);
  assert.deepEqual(one, { ready: true });
  assert.deepEqual(two, one);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  await api.get("/api/me");
  assert.equal(calls, 3);
});

test("authentication, throttling and writes are never automatically retried", async () => {
  for (const [method, status] of [
    ["GET", 401],
    ["GET", 403],
    ["GET", 429],
    ["POST", 500],
  ]) {
    let calls = 0;
    const api = createSessionApi({
      interval: 0,
      pause: async () => {},
      authorize: (request) => ({
        ...request,
        headers: { Authorization: "fake" },
      }),
      fetcher: async () => {
        calls++;
        return new Response("", { status });
      },
    });
    await assert.rejects(
      method === "GET" ? api.get("/api/me") : api.post("/api/me", {}),
    );
    assert.equal(calls, 1);
  }
});

test("account changes stop a paused GET retry before another request", async () => {
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    pause: async () => api.clear(),
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async () => {
      calls++;
      return new Response("", { status: 500 });
    },
  });
  await assert.rejects(api.get("/api/me"), /Сессия изменилась/);
  assert.equal(calls, 1);
});
