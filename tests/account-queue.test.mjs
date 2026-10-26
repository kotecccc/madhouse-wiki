import test from "node:test";
import assert from "node:assert/strict";
import { createAccountQueue } from "../scripts/automation/account-queue.mjs";

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
