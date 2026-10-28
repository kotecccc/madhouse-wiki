import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAccountQueue } from "./account-queue.mjs";
import {
  emptyGameOutage,
  createGameOutageFetch,
  gameProbeSucceeded,
  recordGameFailure,
  reserveGameProbe,
} from "./game-outage.mjs";

test("distinct recent routes open a common outage, without storing paths", () => {
  let state = emptyGameOutage();
  state = recordGameFailure(state, "/api/me", 1000, () => 0);
  state = recordGameFailure(state, "/api/me", 2000, () => 0);
  assert.equal(state.readyAt, 0);
  assert.equal(state.evidence.length, 1);
  assert.doesNotMatch(JSON.stringify(state), /api|me/);
  state = recordGameFailure(state, "/api/works/open", 3000, () => 0);
  assert.deepEqual(state, { evidence: [], readyAt: 13000, failures: 1 });
});

test("common outage stops dispatch, reserves one safe probe, then recovers", async () => {
  let state = emptyGameOutage(),
    clock = 1000,
    healthy = false;
  const calls = [];
  const guarded = createGameOutageFetch({
    load: () => state,
    save: (next) => {
      state = next;
    },
    now: () => clock,
    random: () => 0,
    fetcher: async (url, init = {}) => {
      calls.push({ path: new URL(url).pathname, method: init.method || "GET" });
      if (!healthy) return new Response(null, { status: 503 });
      return Response.json({ playerId: 17 });
    },
  });
  const init = { headers: { Authorization: "Bearer fake" } };
  await guarded("https://game.test/api/me", init);
  await guarded("https://game.test/api/bag", init);
  await assert.rejects(
    guarded("https://game.test/api/buy", { ...init, method: "POST" }),
    (error) => error.notDispatched === true && error.retryAfterMs === 10000,
  );
  assert.equal(calls.length, 2);
  clock += 10000;
  healthy = true;
  await guarded("https://game.test/api/buy", { ...init, method: "POST" });
  assert.deepEqual(calls.slice(2), [
    { path: "/api/me", method: "GET" },
    { path: "/api/buy", method: "POST" },
  ]);
  assert.deepEqual(state, emptyGameOutage());
});

test("failure to store outage evidence never masks a submitted response", async () => {
  let failed = false,
    calls = 0;
  const guarded = createGameOutageFetch({
    load: emptyGameOutage,
    save: () => {
      throw new Error("disk failure");
    },
    onStorageError: () => {
      failed = true;
    },
    fetcher: async () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  });
  const response = await guarded("https://game.test/api/buy", {
    method: "POST",
  });
  assert.equal(response.status, 503);
  assert.equal(failed, true);
  await assert.rejects(
    guarded("https://game.test/api/buy", { method: "POST" }),
    (error) => error.notDispatched === true,
  );
  assert.equal(calls, 1);
});

test("stop during the recovery probe prevents the waiting mutation", async () => {
  let state = { evidence: [], readyAt: 1000, failures: 1 };
  let finishProbe,
    startedProbe,
    enabled = true,
    mutations = 0;
  const started = new Promise((resolve) => {
    startedProbe = resolve;
  });
  const lane = createAccountQueue(async (_url, init = {}) => {
    if (init.method === "GET") {
      startedProbe();
      return new Promise((resolve) => {
        finishProbe = resolve;
      });
    }
    mutations++;
    return Response.json({ ok: true });
  });
  const guarded = createGameOutageFetch({
    fetcher: lane,
    load: () => state,
    save: (next) => {
      state = next;
    },
    now: () => 1000,
    random: () => 0,
  });
  const pending = guarded("https://game.test/api/buy", {
    method: "POST",
    headers: { Authorization: "Bearer fake" },
    canDispatch: () => enabled,
  });
  await started;
  enabled = false;
  finishProbe(Response.json({ playerId: 17 }));
  await assert.rejects(pending, (error) => error.notDispatched === true);
  assert.equal(mutations, 0);
});

test("simultaneous requests share one recovery probe", async () => {
  let state = { evidence: [], readyAt: 1000, failures: 1 };
  let finishProbe,
    probes = 0,
    requests = 0;
  const started = new Promise((resolve) => {
    finishProbe = resolve;
  });
  const guarded = createGameOutageFetch({
    load: () => state,
    save: (next) => {
      state = next;
    },
    now: () => 1000,
    random: () => 0,
    fetcher: async (url) => {
      if (new URL(url).pathname === "/api/me") {
        probes++;
        await started;
        return Response.json({ playerId: 17 });
      }
      requests++;
      return Response.json({ ok: true });
    },
  });
  const init = { headers: { Authorization: "Bearer fake" } };
  const first = guarded("https://game.test/api/a", init);
  const second = guarded("https://game.test/api/b", init);
  assert.equal(probes, 1);
  finishProbe();
  await Promise.all([first, second]);
  assert.equal(probes, 1);
  assert.equal(requests, 2);
});

test("failed recovery probe honors Retry-After for all waiting requests", async () => {
  let state = { evidence: [], readyAt: 1000, failures: 1 },
    calls = 0;
  const guarded = createGameOutageFetch({
    load: () => state,
    save: (next) => {
      state = next;
    },
    now: () => 1000,
    random: () => 0,
    fetcher: async () => {
      calls++;
      return new Response(null, {
        status: 503,
        headers: { "Retry-After": "120" },
      });
    },
  });
  const init = { method: "POST", headers: { Authorization: "Bearer fake" } };
  await assert.rejects(
    guarded("https://game.test/api/buy", init),
    (error) => error.notDispatched && error.retryAfterMs === 120000,
  );
  assert.equal(state.readyAt, 121000);
  await assert.rejects(
    guarded("https://game.test/api/buy", init),
    (error) => error.notDispatched && error.retryAfterMs === 120000,
  );
  assert.equal(calls, 1);
});

test("old observations do not turn isolated failures into a common outage", () => {
  let state = recordGameFailure(emptyGameOutage(), "/api/me", 1000, () => 0);
  state = recordGameFailure(state, "/api/works/open", 61001, () => 0);
  assert.equal(state.readyAt, 0);
  assert.equal(state.evidence.length, 1);
});

test("the first subsystem's Retry-After remains binding when the breaker opens", () => {
  let state = recordGameFailure(
    emptyGameOutage(),
    "/api/me",
    1000,
    () => 0,
    120000,
  );
  state = recordGameFailure(state, "/api/me", 2000, () => 0);
  state = recordGameFailure(state, "/api/works/open", 3000, () => 0);
  assert.equal(state.readyAt, 121000);
});

test("requests proved unsent do not count as evidence of a game outage", async () => {
  let state = emptyGameOutage();
  const guarded = createGameOutageFetch({
    load: () => state,
    save: (next) => {
      state = next;
    },
    fetcher: async () => {
      throw Object.assign(new TypeError("not sent"), { notDispatched: true });
    },
  });
  await assert.rejects(guarded("https://game.test/api/a"));
  await assert.rejects(guarded("https://game.test/api/b"));
  assert.deepEqual(state, emptyGameOutage());
});

test("different IDs on the same route are not independent outage evidence", () => {
  let state = recordGameFailure(emptyGameOutage(), "/api/bosses/11", 1000);
  state = recordGameFailure(state, "/api/bosses/12", 2000);
  assert.equal(state.readyAt, 0);
  assert.equal(state.evidence.length, 1);
});

test("a business and its upgrade route do not imply a global outage", () => {
  let state = recordGameFailure(emptyGameOutage(), "/api/businesses/7", 1000);
  state = recordGameFailure(state, "/api/businesses/7/upgrade", 2000);
  assert.equal(state.readyAt, 0);
});

test("a persisted probe reservation backs off before the next attempt", () => {
  const open = { evidence: [], readyAt: 10000, failures: 1 };
  assert.equal(
    reserveGameProbe(open, 9999, () => 0),
    null,
  );
  const reserved = reserveGameProbe(open, 10000, () => 0);
  assert.deepEqual(reserved, { evidence: [], readyAt: 40000, failures: 2 });
  assert.equal(
    reserveGameProbe(reserved, 10000, () => 0),
    null,
  );
  assert.deepEqual(gameProbeSucceeded(), emptyGameOutage());
});

test("outage and probe reservation survive restart and reject stale lease owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "game-outage-"));
  const first = createAutomationStateStore({ directory });
  const second = createAutomationStateStore({ directory });
  try {
    assert.deepEqual(first.getGameOutage(), emptyGameOutage());
    assert.equal(first.acquireLease("first", 1000, 1000), true);
    let state = recordGameFailure(first.getGameOutage(), "/api/me", 1000);
    first.setGameOutage(state, "first", 1000);
    state = recordGameFailure(state, "/api/works/open", 1100, () => 0);
    first.setGameOutage(state, "first", 1100);
    assert.deepEqual(second.getGameOutage(), state);
    assert.equal(second.acquireLease("second", 2000, 1000), true);
    assert.throws(
      () => first.setGameOutage(emptyGameOutage(), "first", 2000),
      /automation_worker_unavailable/,
    );
    const reserved = reserveGameProbe(second.getGameOutage(), 11100, () => 0);
    assert.equal(second.acquireLease("second", 11100, 1000), true);
    second.setGameOutage(reserved, "second", 11100);
    assert.equal(reserveGameProbe(first.getGameOutage(), 11100), null);
    const reopened = createAutomationStateStore({ directory });
    try {
      assert.deepEqual(reopened.getGameOutage(), reserved);
    } finally {
      reopened.close();
    }
    assert.throws(
      () =>
        second.setGameOutage({ ...reserved, token: "secret" }, "second", 11100),
      /invalid_game_outage/,
    );
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a restarted worker respects the outage and recovers without replaying a mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "game-outage-restart-"));
  let store = createAutomationStateStore({ directory });
  let clock = 1000,
    online = false,
    mutations = 0,
    probes = 0;
  const transport = async (url, init = {}) => {
    if (!online) return new Response(null, { status: 503 });
    if (new URL(url).pathname === "/api/me") {
      probes++;
      return Response.json({ playerId: 1 });
    }
    if (init.method === "POST") mutations++;
    return Response.json({ ok: true });
  };
  const makeGuard = (owner) =>
    createGameOutageFetch({
      fetcher: createAccountQueue(transport, { now: () => clock }),
      load: () => store.getGameOutage(),
      save: (value) => {
        assert.equal(store.acquireLease(owner, clock, 15000), true);
        store.setGameOutage(value, owner, clock);
      },
      now: () => clock,
      random: () => 0,
    });
  const init = { headers: { Authorization: "Bearer fake" } };
  try {
    let guarded = makeGuard("first");
    await guarded("https://game.test/api/works/open", init);
    await guarded("https://game.test/api/me/bag", init);
    store.releaseLease("first");
    store.close();
    store = createAutomationStateStore({ directory });
    guarded = makeGuard("second");
    online = true;
    await assert.rejects(
      guarded("https://game.test/api/buy", { ...init, method: "POST" }),
      (error) => error.notDispatched === true,
    );
    assert.equal(mutations, 0);
    clock += 10000;
    await guarded("https://game.test/api/buy", { ...init, method: "POST" });
    assert.equal(probes, 1);
    assert.equal(mutations, 1);
    assert.deepEqual(store.getGameOutage(), emptyGameOutage());
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
