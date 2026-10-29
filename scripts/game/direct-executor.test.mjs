import assert from "node:assert/strict";
import test from "node:test";
import { createDirectExecutor } from "./direct-executor.mjs";

const reply = (status = 200, retryAfter) => ({
  status,
  headers: {
    get: (name) =>
      name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null,
  },
});

test("rejects non-game origins without invoking fetcher", async () => {
  let calls = 0;
  const executor = createDirectExecutor({
    fetcher: async () => {
      calls += 1;
    },
  });
  await assert.rejects(
    executor.request("https://example.com/api/work"),
    (error) => error.notDispatched,
  );
  assert.equal(calls, 0);
  executor.close();
});

test("rechecks canDispatch at the physical send boundary and strips it from fetch init", async () => {
  let allowed = true;
  const calls = [];
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return reply();
    },
  });
  const result = await executor.request("https://cargohustle.online/api/work", {
    method: "POST",
    canDispatch: () => allowed,
  });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
  assert.equal("canDispatch" in calls[0].init, false);

  allowed = false;
  await assert.rejects(
    executor.request("https://cargohustle.online/api/work", {
      canDispatch: () => allowed,
    }),
    (error) => error.notDispatched,
  );
  assert.equal(calls.length, 1);
  executor.close();
});

test("awaits context canDispatch and honors a deadline that expires during the guard", async () => {
  let calls = 0;
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async () => {
      calls += 1;
      return reply();
    },
  });
  const allowed = await executor.request(
    "https://cargohustle.online/api/allowed",
    {},
    {
      canDispatch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return true;
      },
    },
  );
  assert.equal(allowed.status, 200);
  const expired = executor.request(
    "https://cargohustle.online/api/expired",
    {},
    {
      queueTimeoutMs: 10,
      canDispatch: () =>
        new Promise((resolve) => setTimeout(() => resolve(true), 30)),
    },
  );
  await assert.rejects(
    expired,
    (error) => error.notDispatched && error.code === "DIRECT_REQUEST_DEADLINE",
  );
  assert.equal(calls, 1);
  executor.close();
});

test("cancels and expires queued requests with notDispatched", async () => {
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 500,
    minAccountSpacingMs: 0,
    maxQueueWaitMs: 25,
    fetcher: async () => reply(),
  });
  await executor.request("https://cargohustle.online/api/one");
  const controller = new AbortController();
  const cancelled = executor.request(
    "https://cargohustle.online/api/two",
    {},
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(
    cancelled,
    (error) => error.notDispatched && error.code === "DIRECT_REQUEST_CANCELLED",
  );
  const expired = executor.request("https://cargohustle.online/api/three");
  await assert.rejects(
    expired,
    (error) => error.notDispatched && error.code === "DIRECT_REQUEST_DEADLINE",
  );
  executor.close();
});

test("an expired guard does not permanently block other accounts", async () => {
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async () => reply(),
  });
  try {
    const blocked = executor.request(
      "https://cargohustle.online/api/one",
      {},
      {
        queueTimeoutMs: 10,
        canDispatch: () => new Promise(() => {}),
      },
    );
    const ready = executor.request(
      "https://cargohustle.online/api/two",
      {},
      {
        queueTimeoutMs: 200,
        accountId: "other",
      },
    );
    await assert.rejects(blocked, (error) => error.notDispatched);
    assert.equal((await ready).status, 200);
  } finally {
    executor.close();
  }
});

test("account cooldown from Retry-After does not block another account", async () => {
  const calls = [];
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async (url) => {
      calls.push(url);
      return calls.length === 1 ? reply(429, "0.08") : reply();
    },
  });
  await executor.request(
    "https://cargohustle.online/api/first",
    {},
    { accountId: "verified-a", cooldownScope: "account" },
  );
  const delayed = executor.request(
    "https://cargohustle.online/api/second",
    {},
    { accountId: "verified-a", cooldownScope: "account" },
  );
  const independent = executor.request(
    "https://cargohustle.online/api/other",
    {},
    { accountId: "verified-b", cooldownScope: "account" },
  );
  await independent;
  assert.match(calls[1], /other$/);
  await delayed;
  assert.equal(calls.length, 3);
  executor.close();
});

test("defaults use global 429 cooldown and diagnostics contain no request details", async () => {
  let calls = 0;
  const executor = createDirectExecutor({
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async () => {
      calls += 1;
      return calls === 1 ? reply(429, "0.04") : reply();
    },
  });
  await executor.request(
    "https://cargohustle.online/api/first",
    {},
    { accountId: "secret-owner-token" },
  );
  const next = executor.request(
    "https://cargohustle.online/api/second",
    {},
    { accountId: "another-token" },
  );
  await next;
  assert.equal(calls, 2);
  const diagnostics = JSON.stringify(executor.diagnostics());
  assert.equal(diagnostics.includes("secret"), false);
  assert.equal(diagnostics.includes("cargohustle"), false);
  executor.close();
});

test("HTTP-date Retry-After uses the shared cooldown with a controlled clock", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const executor = createDirectExecutor({
    now: () => now,
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    fetcher: async () =>
      ++calls === 1 ? reply(429, new Date(now + 2000).toUTCString()) : reply(),
  });
  try {
    await executor.request("https://cargohustle.online/api/one");
    const waiting = executor.request("https://cargohustle.online/api/two");
    await Promise.resolve();
    assert.equal(calls, 1);
    now += 2000;
    const wake = executor.request("https://cargohustle.online/api/three");
    await Promise.all([waiting, wake]);
    assert.equal(calls, 3);
  } finally {
    executor.close();
  }
});
