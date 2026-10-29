import test from "node:test";
import assert from "node:assert/strict";
import { createSessionApi } from "../shared/session-api.js";

test("a stale live profile response never replaces confirmed profile data", async () => {
  let stale = false;
  const events = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async () =>
      new Response(JSON.stringify({ wallet: stale ? 1 : 20 }), {
        headers: { "X-Madhouse-Snapshot": stale ? "stale" : "current" },
      }),
  });
  api.subscribe((event) => events.push(event));
  assert.deepEqual(
    await api.get("/api/me", { fresh: true, serverRefresh: "live" }),
    { wallet: 20 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  stale = true;
  await assert.rejects(
    api.get("/api/me", { fresh: true, serverRefresh: "live" }),
    /Актуальные данные/,
  );
  assert.deepEqual(api.peek("/api/me", { allowStale: true }), { wallet: 20 });
  assert.equal(events.filter((event) => event.path === "/api/me").length, 1);
});

test("session GET cache deduplicates, spaces requests, expires and clears between accounts", async () => {
  let clock = 0;
  let account = "fake-session-a";
  const starts = [];
  const api = createSessionApi({
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    ttl: 180000,
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
  assert.equal((await api.get("/api/me")).account, "fake-session-a");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts.length, 3);
  account = "fake-session-b";
  assert.equal((await api.get("/api/me")).account, account);
  assert.equal(starts.length, 4);
  assert.equal(two.url, "/api/floors");
  api.clear();
});

test("unmounting the first consumer does not cancel a shared snapshot read", async () => {
  const first = new AbortController();
  let release;
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({ ...request, headers: { Authorization: "a" } }),
    fetcher: async (_url, { signal }) => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return Response.json({ floor: "J" });
    },
  });
  const one = api.get("/api/floors/J/info", { signal: first.signal });
  const two = api.get("/api/floors/J/info");
  await new Promise((resolve) => setImmediate(resolve));
  first.abort();
  release();
  assert.deepEqual(await one, { floor: "J" });
  assert.deepEqual(await two, { floor: "J" });
  assert.equal(calls, 1);
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

test("strict stored reads preserve empty and stale snapshots and report missing without retry", async () => {
  let calls = 0;
  const headers = [];
  const api = createSessionApi({
    now: () => 100_000,
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake-session" },
    }),
    fetcher: async (_url, options) => {
      calls++;
      headers.push(options.headers["X-Madhouse-Stored-Only"] ?? null);
      if (calls === 1)
        return Response.json(
          { error: "snapshot_unavailable" },
          { status: 404 },
        );
      return Response.json([], {
        headers: {
          "X-Madhouse-Snapshot": "stale",
          "X-Madhouse-Section-Updated": "12345",
          "X-Madhouse-Snapshot-TTL": "1",
        },
      });
    },
  });

  assert.deepEqual(await api.readStored("/api/me/bag"), {
    presence: "unknown",
    data: null,
    updatedAt: null,
    snapshotStatus: "missing",
    source: "stored",
  });
  assert.deepEqual(await api.readStored("/api/me/bag"), {
    presence: "present",
    data: [],
    updatedAt: 12345,
    snapshotStatus: "stale",
    source: "stored",
    gameStatus: "unknown",
  });
  api.refreshExpired();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.deepEqual(headers, ["1", "1"]);
});

test("a late stored read cannot publish after the session is cleared", async () => {
  let finish;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake-session" },
    }),
    fetcher: () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  });
  const events = [];
  api.subscribe((event) => events.push(event));
  const pending = api.readStored("/api/me");
  await ready;
  api.clear();
  finish(Response.json({ playerId: 42 }));
  await assert.rejects(pending);
  assert.equal(
    events.some((event) => event.path === "/api/me"),
    false,
  );
});

test("stored reads proceed while a game-backed fetch is stalled", async () => {
  let releaseGameFetch;
  const started = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "game-session" },
    }),
    authorizeStored: (request) => ({
      ...request,
      headers: { Authorization: "wiki-session" },
    }),
    fetcher: (url, options) => {
      started.push({ url, options });
      if (url.endsWith("/api/me"))
        return new Promise((resolve) => {
          releaseGameFetch = resolve;
        });
      return Promise.resolve(Response.json({ version: 7 }));
    },
  });

  const gameRead = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const storedRead = await api.readStored("/api/automation/state");
  assert.equal(storedRead.data.version, 7);
  assert.deepEqual(
    started.map(({ url }) => url),
    ["/api/me", "/api/automation/state"],
  );
  assert.equal(started[1].options.headers.Authorization, "wiki-session");

  releaseGameFetch(Response.json({ playerId: 42 }));
  await gameRead;
});

test("only local stop and queue-cancel commands bypass a stalled game fetch", async () => {
  let releaseGameFetch;
  const started = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "game-session" },
    }),
    authorizeStored: (request) => ({
      ...request,
      headers: { Authorization: "wiki-session" },
    }),
    fetcher: (url, options) => {
      started.push({ url, options });
      if (url.endsWith("/api/me"))
        return new Promise((resolve) => {
          releaseGameFetch = resolve;
        });
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const gameRead = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  await api.post("/api/automation/commands", {
    id: "stop-1",
    command: "work.stop",
    args: {},
  });
  await api.post("/api/automation/commands", {
    id: "cancel-1",
    command: "queue.cancel",
    args: { id: "queued-job" },
  });
  assert.deepEqual(
    started.map(({ url }) => url),
    ["/api/me", "/api/automation/commands", "/api/automation/commands"],
  );
  assert.equal(started[1].options.headers.Authorization, "game-session");
  assert.equal(started[2].options.headers.Authorization, "game-session");

  releaseGameFetch(Response.json({ playerId: 42 }));
  await gameRead;
});

test("local reads and ordered stop commands bypass game pacing and stalled reads", async () => {
  let releaseGameFetch;
  let releaseStoredRead;
  let storedStarted;
  let pauseCalls = 0;
  const storedRequestStarted = new Promise((resolve) => {
    storedStarted = resolve;
  });
  const started = [];
  const api = createSessionApi({
    interval: 1100,
    pause: async () => {
      pauseCalls++;
      throw new Error("Local operation unexpectedly used game pacing");
    },
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "game-session" },
    }),
    authorizeStored: (request) => ({
      ...request,
      headers: { Authorization: "wiki-session" },
    }),
    fetcher: (url) => {
      started.push(url);
      if (url.endsWith("/api/me"))
        return new Promise((resolve) => {
          releaseGameFetch = resolve;
        });
      if (url.endsWith("/api/automation/state"))
        return new Promise((resolve) => {
          releaseStoredRead = resolve;
          storedStarted();
        });
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const gameRead = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const storedRead = api.readStored("/api/automation/state");
  await storedRequestStarted;
  const firstStop = api.post("/api/automation/commands", {
    id: "stop-1",
    command: "work.stop",
    args: {},
  });
  const secondStop = api.post("/api/automation/commands", {
    id: "stop-2",
    command: "auto.stop",
    args: {},
  });
  await Promise.all([firstStop, secondStop]);

  assert.deepEqual(started, [
    "/api/me",
    "/api/automation/state",
    "/api/automation/commands",
    "/api/automation/commands",
  ]);
  assert.equal(pauseCalls, 0);

  releaseStoredRead(Response.json({ version: 7 }));
  releaseGameFetch(Response.json({ playerId: 42 }));
  await Promise.all([gameRead, storedRead]);
});

test("Wiki session authorizes only allowlisted local commands after game JWT expiry", async () => {
  const previousWindow = globalThis.window;
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const target = new EventTarget();
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    location: {
      origin: "https://wiki.example",
      hash:
        "#tgWebAppData=" +
        encodeURIComponent('user={"id":42}&hash=' + "a".repeat(64)),
    },
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  try {
    const {
      saveToken,
      saveWikiSession,
      clearToken,
      authorizeRequest,
      authorizeStoredRequest,
      authorizeLocalAutomationCommand,
    } = await import("../shared/auth-session.js");
    const jwt = (payload) =>
      [
        Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "fake-signature",
      ].join(".");
    clearToken();
    saveToken(jwt({ exp: 5 }));
    saveWikiSession("wiki-session", {
      expiresAt: Date.now() + 60_000,
      gameConnection: "login-required",
    });
    now = 6000;
    const calls = [];
    const api = createSessionApi({
      interval: 0,
      authorize: authorizeRequest,
      authorizeStored: authorizeStoredRequest,
      authorizeLocalCommand: authorizeLocalAutomationCommand,
      fetcher: async (_url, options) => {
        calls.push(options);
        return Response.json({ ok: true });
      },
    });

    await api.post("/api/automation/commands", {
      id: "stop-1",
      command: "work.stop",
      args: {},
    });
    assert.equal(calls[0].headers.Authorization, "Bearer wiki-session");
    await assert.rejects(
      api.post("/api/automation/commands", {
        id: "enqueue-1",
        command: "queue.enqueue",
        args: { type: "work.start" },
      }),
      /JWT истёк|действующий JWT/,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      (await import("../shared/auth-session.js")).readSession().status,
      "expired",
    );
    api.clear();
    clearToken();
  } finally {
    Date.now = realNow;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("Wiki-authenticated stop preserves the active game credential identity", async () => {
  let releaseGameFetch;
  const started = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "Bearer game-jwt" },
    }),
    authorizeLocalCommand: (request, command) => {
      assert.equal(command, "work.stop");
      return {
        ...request,
        headers: { Authorization: "Bearer wiki-session" },
      };
    },
    fetcher: (url, options) => {
      started.push({ url, options });
      if (url.endsWith("/api/me"))
        return new Promise((resolve) => {
          releaseGameFetch = resolve;
        });
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const gameRead = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  await api.post("/api/automation/commands", {
    id: "stop-1",
    command: "work.stop",
    args: {},
  });
  assert.equal(started[1].options.headers.Authorization, "Bearer wiki-session");
  releaseGameFetch(Response.json({ playerId: 42 }));
  assert.deepEqual(await gameRead, { playerId: 42 });
  assert.deepEqual(api.peek("/api/me"), { playerId: 42 });
});

test("game actions remain behind stalled game fetches", async () => {
  let releaseGameFetch;
  const started = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "game-session" },
    }),
    fetcher: (url, options) => {
      started.push({ url, options });
      if (url.endsWith("/api/me"))
        return new Promise((resolve) => {
          releaseGameFetch = resolve;
        });
      return Promise.resolve(Response.json({ ok: true }));
    },
  });

  const gameRead = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  let commandSettled = false;
  const gameAction = api
    .post("/api/automation/commands", {
      id: "action-1",
      command: "queue.enqueue",
      args: { type: "work.start" },
    })
    .then(() => {
      commandSettled = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandSettled, false);
  assert.deepEqual(
    started.map(({ url }) => url),
    ["/api/me"],
  );

  releaseGameFetch(Response.json({ playerId: 42 }));
  await Promise.all([gameRead, gameAction]);
  assert.deepEqual(
    started.map(({ url }) => url),
    ["/api/me", "/api/automation/commands"],
  );
});

test("strict stored reads reject paths outside the account snapshot contract", async () => {
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake-session" },
    }),
    fetcher: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(api.readStored("/api/automation/bosses"));
  assert.equal(calls, 0);
});

test("strict stored read does not retry transient Wiki responses", async () => {
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    pause: async () => {},
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake-session" },
    }),
    fetcher: async () => {
      calls++;
      return Response.json(
        { error: "temporarily_unavailable" },
        {
          status: 503,
        },
      );
    },
  });
  await assert.rejects(api.readStored("/api/me"));
  assert.equal(calls, 1);
});

test("strict stored API calls use their own credential without game authorization", async () => {
  const headers = [];
  const api = createSessionApi({
    interval: 0,
    authorize: () => {
      throw new Error("game token expired");
    },
    authorizeStored: (request) => ({
      ...request,
      headers: { Authorization: "Bearer wiki-session" },
    }),
    fetcher: async (_url, options) => {
      headers.push(options.headers.Authorization);
      return Response.json({ profile: true });
    },
  });
  assert.deepEqual(await api.readStored("/api/me"), {
    presence: "present",
    data: { profile: true },
    updatedAt: null,
    snapshotStatus: "current",
    source: "stored",
    gameStatus: "unknown",
  });
  await assert.rejects(api.get("/api/me"), /game token expired/);
  assert.deepEqual(headers, ["Bearer wiki-session"]);
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

test("cached profile identity can be read without another request and never crosses accounts", async () => {
  let account = "account-a";
  let clock = 0;
  let calls = 0;
  const events = [];
  const api = createSessionApi({
    authorize: (request) => ({
      ...request,
      headers: { Authorization: account },
    }),
    now: () => clock,
    ttl: 180000,
    interval: 0,
    fetcher: async () => {
      calls++;
      return { ok: true, json: async () => ({ nickname: "Игрок A" }) };
    },
  });
  api.subscribe((event) => events.push(event));
  assert.equal(api.peek("/api/me"), null);
  await api.get("/api/me");
  events.length = 0;
  clock = 180001;
  assert.equal(api.peek("/api/me"), null);
  assert.equal(api.peek("/api/me", { allowStale: true }).nickname, "Игрок A");
  assert.equal(calls, 1);
  account = "account-b";
  assert.equal(api.peek("/api/me", { allowStale: true }), null);
  assert.equal(calls, 1);
  assert.deepEqual(events, []);
});

test("server snapshot outages are reported once without retrying a handled read", async () => {
  const { readGameHealth } = await import("../shared/session-api.js");
  let calls = 0;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "Bearer fake" },
    }),
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ error: "snapshot_unknown" }), {
        status: 503,
        headers: { "X-Madhouse-Game-Status": "unavailable" },
      });
    },
  });
  await assert.rejects(api.get("/api/me"));
  assert.equal(calls, 1);
  assert.deepEqual(readGameHealth(), {
    status: "unavailable",
    lastSuccessAt: null,
    failedFeatures: [],
    successfulFeatures: [],
    featureCheckedAt: {},
  });
  api.clear();
  assert.equal(readGameHealth().status, "unknown");
});

test("snapshot reads use server timestamps for expiry and revalidate stale data in the background", async () => {
  let clock = 1_000_000;
  const requests = [];
  const events = [];
  let call = 0;
  const api = createSessionApi({
    now: () => clock,
    interval: 0,
    authorize: (request) => ({ ...request, headers: { Authorization: "a" } }),
    fetcher: async (_url, options) => {
      requests.push(options.headers["X-Madhouse-Snapshot-Only"] ?? null);
      call++;
      return new Response(JSON.stringify({ revision: call }), {
        headers: {
          "Content-Type": "application/json",
          "X-Madhouse-Section-Updated": "900000",
          "X-Madhouse-Snapshot-TTL": "200000",
        },
      });
    },
  });
  api.subscribe((event) => events.push(event));
  assert.deepEqual(await api.get("/api/me"), { revision: 1 });
  assert.deepEqual(requests, ["1"]);
  // The deadline is sectionUpdated + server TTL, not response time + TTL.
  clock = 1_100_000;
  assert.deepEqual(await api.get("/api/me"), { revision: 1 });
  assert.equal(requests.length, 1);
  clock = 1_100_001;
  assert.deepEqual(await api.get("/api/me"), { revision: 1 });
  assert.equal(api.isRefreshing(), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, ["1", null]);
  assert.deepEqual(api.peek("/api/me", { allowStale: true }), { revision: 2 });
  assert.equal(api.isRefreshing(), false);
  assert.ok(
    events.some(
      (event) => event.path === "/api/me" && event.data.revision === 2,
    ),
  );
  assert.ok(events.some((event) => event.refreshing === true));
});

test("failed background refresh retains stale data and cooldown prevents a request storm", async () => {
  let clock = 10_000;
  let calls = 0;
  const api = createSessionApi({
    now: () => clock,
    interval: 0,
    ttl: 100,
    pause: async () => {},
    authorize: (request) => ({ ...request, headers: { Authorization: "a" } }),
    fetcher: async () =>
      ++calls === 1
        ? Response.json({ saved: true })
        : new Response("", {
            status: 503,
            headers: { "X-Madhouse-Game-Status": "unavailable" },
          }),
  });
  assert.deepEqual(await api.get("/api/me"), { saved: true });
  clock += 101;
  assert.deepEqual(await api.get("/api/me"), { saved: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(api.peek("/api/me", { allowStale: true }), { saved: true });
  await api.get("/api/me");
  assert.equal(calls, 2);
});

test("fresh snapshot reads omit snapshot-only and explicit refresh guard prevents background work", async () => {
  let clock = 1_000;
  let visible = false;
  const headers = [];
  let calls = 0;
  const api = createSessionApi({
    now: () => clock,
    interval: 0,
    ttl: 10,
    shouldRefresh: () => visible,
    authorize: (request) => ({ ...request, headers: { Authorization: "a" } }),
    fetcher: async (_url, options) => {
      calls++;
      headers.push(options.headers["X-Madhouse-Snapshot-Only"] ?? null);
      return Response.json({ revision: calls });
    },
  });
  await api.get("/api/me");
  clock += 11;
  assert.deepEqual(await api.get("/api/me"), { revision: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(await api.get("/api/me", { fresh: true }), { revision: 2 });
  assert.deepEqual(headers, ["1", null]);
  visible = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await api.get("/api/me", { fresh: true });
  assert.deepEqual(headers, ["1", null, null]);
});

test("a queued refresh waits for the app to become visible again", async () => {
  let clock = 1000;
  let visible = true;
  let calls = 0;
  let release;
  const api = createSessionApi({
    now: () => clock,
    interval: 100,
    ttl: 10,
    shouldRefresh: () => visible,
    pause: (ms) =>
      new Promise((resolve) => {
        release = () => {
          clock += ms;
          resolve();
        };
      }),
    authorize: (request) => ({ ...request, headers: { Authorization: "a" } }),
    fetcher: async () => Response.json({ revision: ++calls }),
  });
  await api.get("/api/me");
  await new Promise((resolve) => setTimeout(resolve, 0));
  clock += 11;
  api.refreshExpired();
  await Promise.resolve();
  visible = false;
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(api.isRefreshing(), false);
  assert.deepEqual(api.peek("/api/me", { allowStale: true }), { revision: 1 });
  visible = true;
  api.refreshExpired();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
});

test("event-driven wardrobe lists never poll on TTL, reopening, or background sweeps", async () => {
  let clock = 1000;
  let account = "account-a";
  let calls = 0;
  const headers = [];
  const api = createSessionApi({
    now: () => clock,
    interval: 0,
    ttl: 10,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: account },
    }),
    fetcher: async (_url, options) => {
      headers.push(options.headers["X-Madhouse-Snapshot-Only"] ?? null);
      return Response.json(
        { items: [{ weaponId: 1, owned: true }], revision: ++calls },
        {
          headers: {
            "X-Madhouse-Section-Updated": "1",
            "X-Madhouse-Snapshot-TTL": "10",
          },
        },
      );
    },
  });
  const path = "/api/clothing/by-category/1";
  await Promise.all([
    api.get(path, { revalidate: false }),
    api.get(path, { revalidate: false }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  clock += 3600000;
  for (let index = 0; index < 10; index++) {
    api.refreshExpired();
    assert.equal((await api.get(path, { revalidate: false })).revision, 1);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(
    (await api.get(path, { fresh: true, revalidate: false })).revision,
    2,
  );
  assert.deepEqual(headers, ["1", null]);
  account = "account-b";
  assert.equal((await api.get(path, { revalidate: false })).revision, 3);
});

test("observed game errors accept only safe function names and clear on recovery", async () => {
  const { observeGameResponse, readGameHealth } =
    await import("../shared/session-api.js");
  observeGameResponse(
    Response.json(
      {},
      {
        headers: {
          "X-Madhouse-Game-Status": "unavailable",
          "X-Madhouse-Failed-Features":
            "weapons,businesses,weapons,/api/private/123,raw-error",
          "X-Madhouse-Successful-Features":
            "profile,weapons,rooms,/api/private/123",
          "X-Madhouse-Feature-Checked-At":
            '{"profile":1000,"weapons":900,"api/private/123":999,"rooms":"invalid"}',
        },
      },
    ),
  );
  assert.deepEqual(readGameHealth().failedFeatures, ["weapons", "businesses"]);
  assert.deepEqual(readGameHealth().successfulFeatures, ["profile", "rooms"]);
  assert.deepEqual(readGameHealth().featureCheckedAt, {
    profile: 1000,
    weapons: 900,
  });
  observeGameResponse(
    Response.json({}, { headers: { "X-Madhouse-Game-Status": "available" } }),
  );
  assert.deepEqual(readGameHealth().failedFeatures, []);
  assert.deepEqual(readGameHealth().successfulFeatures, []);
});

test("explicit health refresh sends the internal force header for snapshot reads", async () => {
  const calls = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "account" },
    }),
    fetcher: async (url, options) => {
      calls.push({ url, headers: options.headers });
      return Response.json({ ok: true });
    },
  });
  await api.get("/api/me", { fresh: true, serverRefresh: true });
  await api.get("/api/clothing", { fresh: true, serverRefresh: true });
  assert.equal(calls[0].headers["X-Madhouse-Snapshot-Refresh"], "1");
  assert.equal(calls[1].headers["X-Madhouse-Snapshot-Refresh"], "1");
});

test("a forced profile refresh asks the server for current account data and keeps the last good profile on failure", async () => {
  let calls = 0;
  let refreshHeader;
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async (_url, options) => {
      calls++;
      refreshHeader = options.headers["X-Madhouse-Snapshot-Refresh"];
      return calls === 1
        ? Response.json({ energy: { current: 8 }, exp: { current: 40 } })
        : new Response("unavailable", { status: 503 });
    },
  });

  assert.deepEqual(await api.get("/api/me"), {
    energy: { current: 8 },
    exp: { current: 40 },
  });
  await assert.rejects(
    api.get("/api/me", { fresh: true, serverRefresh: "live" }),
  );
  assert.equal(refreshHeader, "live");
  assert.deepEqual(api.peek("/api/me", { allowStale: true }), {
    energy: { current: 8 },
    exp: { current: 40 },
  });
});

test("combined boss cards use one cache key and scope refresh to the winning boss", async () => {
  const headers = [];
  let clock = 1000;
  const api = createSessionApi({
    now: () => clock,
    interval: 0,
    ttl: 10,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "account" },
    }),
    fetcher: async (_url, options) => {
      headers.push(options.headers);
      return Response.json({
        bosses: [{ id: "boss-7", collection: { collected: headers.length } }],
      });
    },
  });
  const path = "/api/automation/bosses";
  await api.get(path, { revalidate: false });
  clock += 100000;
  api.refreshExpired();
  await api.get(path, { revalidate: false });
  assert.equal(headers.length, 1);
  const updated = await api.get(path, {
    fresh: true,
    refreshBoss: 7,
    revalidate: false,
  });
  assert.equal(headers[1]["X-Madhouse-Refresh-Boss"], "7");
  assert.equal(
    (await api.get(path, { revalidate: false })).bosses[0].collection.collected,
    updated.bosses[0].collection.collected,
  );
});

test("section update dates use server timestamps, survive cache hits and remain account scoped", async () => {
  let account = "fake-a";
  let calls = 0;
  const events = [];
  const api = createSessionApi({
    authorize: (request) => ({
      ...request,
      headers: { Authorization: account },
    }),
    interval: 0,
    fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "X-Madhouse-Section-Updated": "1700000000000" },
      });
    },
  });
  api.subscribe((event) => events.push(event));
  await api.get("/api/rooms", { revalidate: false });
  assert.equal(api.updatedAt("/api/rooms"), 1700000000000);
  assert.equal(events.find((event) => event.path)?.updatedAt, 1700000000000);
  await api.get("/api/rooms", { revalidate: false });
  assert.equal(calls, 1);
  account = "fake-b";
  assert.equal(api.updatedAt("/api/rooms"), null);
  api.clear();
  assert.equal(api.updatedAt("/api/rooms"), null);
});

test("remote automation responses can publish account-scoped session updates", () => {
  const events = [];
  const api = createSessionApi({
    authorize: (request) => ({ ...request, headers: {} }),
  });
  api.subscribe((event) => events.push(event));
  api.publishResponse("/api/automation/commands", { queuedActions: [] });
  assert.deepEqual(events, [
    {
      path: "/api/automation/commands",
      data: { queuedActions: [] },
      updatedAt: null,
    },
  ]);
});

test("explicit retry refresh headers apply to snapshot GETs without leaking to mutations", async () => {
  const calls = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({ ...request, headers: {} }),
    fetcher: async (url, init) => {
      calls.push({
        method: init.method,
        refresh: init.headers["X-Madhouse-Snapshot-Refresh"],
      });
      return Response.json({ ok: true });
    },
  });
  await api.get("/api/weapons/1", { fresh: true, serverRefresh: "live" });
  assert.equal(calls[0].refresh, "live");
  await api.post("/api/works/tasks/perform", { workId: 7, taskId: 1 });
  assert.equal(calls[1].refresh, undefined);
  api.clear();
});

test("failure-specific timestamps survive response metadata without counting successful checks as failures", async () => {
  const {
    observeGameResponse,
    readGameHealthWarning,
    readConfirmedGameHealthFeatures,
    reportGameHealth,
  } = await import("../shared/session-api.js");
  reportGameHealth({ status: "unknown" });
  const observe = (checked, failed) =>
    observeGameResponse(
      new Response(null, {
        headers: {
          "X-Madhouse-Game-Status": "unavailable",
          "X-Madhouse-Failed-Features": "bosses",
          "X-Madhouse-Feature-Checked-At": JSON.stringify({ bosses: checked }),
          "X-Madhouse-Feature-Failed-At": JSON.stringify({ bosses: failed }),
        },
      }),
    );
  for (const checked of [1000, 16000, 31000]) observe(checked, 1000);
  assert.equal(readGameHealthWarning(), false);
  observe(32000, 16000);
  observe(33000, 31000);
  assert.deepEqual(readConfirmedGameHealthFeatures(), ["bosses"]);
  reportGameHealth({ status: "available" });
  assert.deepEqual(readConfirmedGameHealthFeatures(), []);
});

test("post-action live refresh waits for a prior read and fetches again", async () => {
  let release;
  const calls = [];
  const api = createSessionApi({
    interval: 0,
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "fake" },
    }),
    fetcher: async (_url, options) => {
      calls.push(options.headers["X-Madhouse-Snapshot-Refresh"]);
      if (calls.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return new Response(JSON.stringify({ revision: calls.length }), {
        headers: { "X-Madhouse-Snapshot": "current" },
      });
    },
  });
  const earlier = api.get("/api/me/bag", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const refresh = api.get("/api/me/bag", {
    fresh: true,
    serverRefresh: "live",
    afterPending: true,
  });
  release();
  await earlier;
  assert.deepEqual(await refresh, { revision: 2 });
  assert.deepEqual(calls, [undefined, "live"]);
});
