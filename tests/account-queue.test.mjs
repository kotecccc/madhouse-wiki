import test from "node:test";
import assert from "node:assert/strict";
import { createAccountQueue } from "../scripts/automation/account-queue.mjs";
import { createActionQueue } from "../scripts/automation/action-queue.mjs";
import { createRequestPriorityContext } from "../scripts/automation/request-priority-context.mjs";

test("dispatch barrier checks the current deadline after waiting in the account lane", async () => {
  let release,
    blocked = false,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetcher = createAccountQueue(
    async () => {
      calls++;
      await gate;
      return Response.json({ ok: true });
    },
    {
      beforeDispatch: () => {
        if (blocked)
          throw Object.assign(new Error("cooldown"), { retryAfterMs: 120000 });
      },
    },
  );
  const init = { headers: { Authorization: "Bearer account" } };
  const first = fetcher("https://game/api/first", init);
  const second = fetcher("https://game/api/second", init);
  const rejected = assert.rejects(
    second,
    (error) => error.notDispatched === true && error.retryAfterMs === 120000,
  );
  blocked = true;
  release();
  await first;
  await rejected;
  assert.equal(calls, 1);
});

test("restored reconciliation reaches the account lane ahead of a farm step", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const paths = [];
  const context = createRequestPriorityContext();
  const fetcher = createAccountQueue(
    async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path === "/api/hold") await gate;
      return Response.json({ ok: true });
    },
    { now: () => 1000, requestPriority: context.current },
  );
  const init = { headers: { Authorization: "Bearer account" } };
  const hold = fetcher("https://game/api/hold", init);
  const farm = fetcher("https://game/api/works/tasks/perform", {
    ...init,
    method: "POST",
  });
  const queue = createActionQueue({
    saved: [
      {
        id: "action-reconcile",
        type: "buy",
        args: {},
        priority: 15,
        createdAt: 0,
        status: "reconciling",
        attempts: 0,
        nextAt: 0,
      },
    ],
    now: () => 1000,
    persist: () => true,
    runInContext: context.run,
    adapters: {
      buy: {
        reconcile: async () => {
          await fetcher("https://game/api/me/bag", init);
          return { status: "completed" };
        },
      },
    },
  });
  const reconciliation = queue.tick();
  release();
  await Promise.all([hold, farm, reconciliation]);
  assert.deepEqual(paths, [
    "/api/hold",
    "/api/me/bag",
    "/api/works/tasks/perform",
  ]);
});

test("per-account lane serializes requests and gives energy and combat priority at request boundaries", async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fetcher = createAccountQueue(async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/api/me") await gate;
    return Response.json({ path });
  });
  const init = { headers: { Authorization: "Bearer account" } };
  const first = fetcher("https://game/api/me", init);
  const background = fetcher("https://game/api/me/bag", init);
  const attack = fetcher("https://game/api/bosses/battles/one/attack", {
    ...init,
    method: "POST",
  });
  const work = fetcher("https://game/api/works/tasks/perform", {
    ...init,
    method: "POST",
  });
  assert.deepEqual(calls, ["/api/me"]);
  release();
  await Promise.all([first, background, attack, work]);
  assert.deepEqual(calls, [
    "/api/me",
    "/api/works/tasks/perform",
    "/api/bosses/battles/one/attack",
    "/api/me/bag",
  ]);
});

test("a failed account does not block another account or poison its own lane", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const fetcher = createAccountQueue(async (url, init) => {
    const account = new Headers(init.headers).get("authorization");
    calls.push(account);
    if (account === "Bearer first" && calls.length === 1) {
      await gate;
      throw new Error("offline");
    }
    return Response.json({ ok: true });
  });
  const first = fetcher("https://game/api/me", {
    headers: { Authorization: "Bearer first" },
  });
  const rejection = assert.rejects(first, /offline/);
  const next = fetcher("https://game/api/me", {
    headers: { Authorization: "Bearer first" },
  });
  const other = await fetcher("https://game/api/me", {
    headers: { Authorization: "Bearer other" },
  });
  assert.equal(other.ok, true);
  release();
  await rejection;
  assert.equal((await next).ok, true);
});

test("reconciliation and invitations precede farm steps at the next request boundary", async () => {
  let release,
    priority = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const fetcher = createAccountQueue(
    async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/hold") await gate;
      return Response.json({ ok: true });
    },
    { requestPriority: () => priority, now: () => 1000 },
  );
  const init = { headers: { Authorization: "Bearer account" } };
  const hold = fetcher("https://game/api/hold", init);
  const farm = fetcher("https://game/api/works/tasks/perform", {
    ...init,
    method: "POST",
  });
  const invite = fetcher("https://game/api/bosses/invitations/42/accept", {
    ...init,
    method: "POST",
  });
  priority = 60;
  const reconcile = fetcher("https://game/api/me/bag", init);
  priority = null;
  release();
  await Promise.all([hold, farm, invite, reconcile]);
  assert.deepEqual(calls, [
    "/api/hold",
    "/api/bosses/invitations/42/accept",
    "/api/me/bag",
    "/api/works/tasks/perform",
  ]);
});

test("an older low-priority request eventually precedes newer urgent work", async () => {
  let release,
    clock = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const fetcher = createAccountQueue(
    async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/hold") await gate;
      return Response.json({ ok: true });
    },
    { now: () => clock },
  );
  const init = { headers: { Authorization: "Bearer account" } };
  const hold = fetcher("https://game/api/hold", init);
  const old = fetcher("https://game/api/me/bag", init);
  clock = 61000;
  const urgent = fetcher("https://game/api/bosses/invitations/42/accept", {
    ...init,
    method: "POST",
  });
  release();
  await Promise.all([hold, old, urgent]);
  assert.deepEqual(calls, [
    "/api/hold",
    "/api/me/bag",
    "/api/bosses/invitations/42/accept",
  ]);
});

test("aborted queued requests never reach the game", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const fetcher = createAccountQueue(async () => {
    calls++;
    await gate;
    return Response.json({});
  });
  const init = { headers: { Authorization: "Bearer first" } };
  const first = fetcher("https://game/api/me", init);
  const controller = new AbortController();
  const pending = fetcher("https://game/api/works/tasks/perform", {
    ...init,
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  release();
  await first;
  await rejection;
  assert.equal(calls, 1);
});

test("dispatch guard cancels a stopped queued action and is not forwarded upstream", async () => {
  let release;
  let allowed = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const fetcher = createAccountQueue(async (url, init) => {
    calls.push(url);
    assert.equal("canDispatch" in init, false);
    await gate;
    return Response.json({});
  });
  const init = { headers: { Authorization: "Bearer account" } };
  const read = fetcher("https://game/api/me", init);
  const action = fetcher("https://game/api/bosses/battles/one/attack", {
    ...init,
    method: "POST",
    canDispatch: () => allowed,
  });
  const rejected = assert.rejects(action, { name: "AbortError" });
  allowed = false;
  release();
  await Promise.all([read, rejected]);
  assert.equal(calls.length, 1);
});
