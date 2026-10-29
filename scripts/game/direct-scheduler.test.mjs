import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectExecutor } from "./direct-executor.mjs";

function clock() {
  let time = 10000,
    serial = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(fn, delay) {
      const id = ++serial;
      timers.set(id, { at: time + delay, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
    },
  };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const url = "https://cargohustle.online/api/me";
const response = (status = 200, retryAfter = null) => ({
  status,
  headers: { get: () => retryAfter },
});

test("separate direct and device slots share the account limit and queued cancellation", async () => {
  const c = clock(),
    holds = [],
    seen = [];
  const executor = createDirectExecutor({
    ...c,
    maxDirectInFlight: 1,
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    minDeviceSpacingMs: 0,
    fetcher: (_url, init) => {
      seen.push(init.label);
      const d = deferred();
      holds.push(d);
      return d.promise;
    },
  });
  const direct = executor.request(
    url,
    { label: "direct-a" },
    { accountId: "a" },
  );
  await flush();
  const bridgeSame = executor.bridge(
    () => {
      seen.push("bridge-a");
      return response();
    },
    {},
    { accountId: "a", deviceId: "one" },
  );
  const directOther = executor.request(
    url,
    { label: "direct-b" },
    { accountId: "b" },
  );
  const bridgeOther = executor.bridge(
    () => {
      seen.push("bridge-c");
      return response();
    },
    {},
    { accountId: "c", deviceId: "two" },
  );
  const controller = new AbortController();
  const cancelled = executor.request(
    url,
    { label: "cancelled" },
    { accountId: "d", signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(cancelled, (error) => error.notDispatched);
  await flush();
  assert.deepEqual(seen, ["direct-a", "bridge-c"]);
  holds[0].resolve(response());
  await direct;
  await flush();
  assert.ok(seen.includes("bridge-a"));
  assert.ok(seen.includes("direct-b"));
  holds[1].resolve(response());
  await Promise.all([bridgeSame, directOther, bridgeOther]);
  executor.close();
});

test("aging lets an old background request pass newer high priority work", async () => {
  const c = clock(),
    first = deferred(),
    seen = [];
  const executor = createDirectExecutor({
    ...c,
    maxDirectInFlight: 1,
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    agingMs: 1000,
    fetcher: (_url, init) => {
      seen.push(init.label);
      return init.label === "first" ? first.promise : response();
    },
  });
  const a = executor.request(
    url,
    { label: "first" },
    { accountId: "a", source: "automation" },
  );
  await flush();
  const old = executor.request(
    url,
    { label: "background" },
    { accountId: "b", source: "catalogue" },
  );
  c.advance(4000);
  const newer = executor.request(
    url,
    { label: "urgent" },
    { accountId: "c", source: "automation" },
  );
  first.resolve(response());
  await Promise.all([a, old, newer]);
  assert.deepEqual(seen, ["first", "background", "urgent"]);
  executor.close();
});

test("raw bridge 429 cools the shared account without consuming direct budget", async () => {
  const c = clock(),
    seen = [];
  const executor = createDirectExecutor({
    ...c,
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    minDeviceSpacingMs: 0,
    fetcher: async () => {
      seen.push("direct");
      return response();
    },
  });
  await executor.bridge(
    () => ({ status: 429, retryAfter: "5" }),
    {},
    { accountId: "a", deviceId: "one", cooldownScope: "account" },
  );
  await flush();
  const delayed = executor.request(url, {}, { accountId: "a" });
  const other = executor.request(url, {}, { accountId: "b" });
  await other;
  await flush();
  assert.deepEqual(seen, ["direct"]);
  c.advance(5000);
  await flush();
  await delayed;
  assert.equal(seen.length, 2);
  executor.close();
});

test("uncertain bridge attempt quarantines only its account and device", async () => {
  const c = clock();
  const executor = createDirectExecutor({
    ...c,
    minGlobalSpacingMs: 0,
    minAccountSpacingMs: 0,
    minDeviceSpacingMs: 0,
    fetcher: async () => response(),
  });
  await assert.rejects(
    executor.bridge(
      () => {
        throw new Error("lost after send");
      },
      { method: "POST" },
      { accountId: "a", deviceId: "one" },
    ),
  );
  await flush();
  const abort = new AbortController();
  const blocked = executor.bridge(
    () => response(),
    {},
    { accountId: "a", deviceId: "one", signal: abort.signal },
  );
  const independent = executor.request(url, {}, { accountId: "b" });
  assert.equal((await independent).status, 200);
  const sameDeviceAbort = new AbortController();
  const sameDevice = executor.bridge(
    () => response(),
    {},
    {
      accountId: "c",
      deviceId: "one",
      signal: sameDeviceAbort.signal,
    },
  );
  const sameAccountAbort = new AbortController();
  const sameAccount = executor.bridge(
    () => response(),
    {},
    {
      accountId: "a",
      deviceId: "two",
      signal: sameAccountAbort.signal,
    },
  );
  sameDeviceAbort.abort();
  sameAccountAbort.abort();
  await assert.rejects(sameDevice, (error) => error.notDispatched);
  await assert.rejects(sameAccount, (error) => error.notDispatched);
  abort.abort();
  await assert.rejects(blocked, (error) => error.notDispatched);
  assert.equal(executor.diagnostics().activeDevices, 0);
  assert.equal(executor.diagnostics().volatileBlocks, 1);
  executor.close();
});
