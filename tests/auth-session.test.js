import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectToken,
  saveToken,
  readSession,
  clearToken,
  authorizeRequest,
  authorizeStoredRequest,
  authorizeLocalAutomationCommand,
  isLocalAutomationCommand,
  saveWikiSession,
  storedSessionIdentity,
  formatExpiry,
  TOKEN_KEY,
  subscribeSession,
} from "../shared/auth-session.js";
const jwt = (payload) =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "testsignature",
  ].join(".");

test("JWT lifetime uses NumericDate seconds and rejects malformed dates and unsigned tokens", () => {
  const future = jwt({ exp: 2000, nbf: 1000, sub: "private-user" });
  assert.deepEqual(inspectToken(" Bearer " + future + " ", 1500000), {
    token: future,
    expiresAt: 2000000,
    notBefore: 1000000,
    status: "ready",
  });
  assert.equal(inspectToken(future, 2000000).status, "expired");
  assert.equal(inspectToken(future, 999000).status, "pending");
  assert.equal(inspectToken(jwt({}), 0).expiresAt, null);
  for (const value of [
    "bad",
    jwt({ exp: "2000" }),
    jwt({ exp: 1e300 }),
    jwt(null),
    "eyJhbGciOiJub25lIn0.e30.signature",
  ])
    assert.throws(() => inspectToken(value));
  assert.match(
    formatExpiry(inspectToken(future, 1500000), 1500000),
    /Истекает/,
  );
});

test("one persisted token is reused for same-origin API requests, expiry and logout block it", () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  const values = new Map();
  const localStorage = {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
  globalThis.window = {
    localStorage,
    location: { origin: "http://127.0.0.1:4174" },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  try {
    const token = jwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "never-expose",
    });
    let changes = 0;
    const unsubscribe = subscribeSession(() => changes++);
    saveToken("Bearer " + token, {
      activeBossBattle: {
        battleId: "battle_1",
        bossId: "42",
        expiresAtUtc: "2026-10-24T12:00:00Z",
        remainingSeconds: 60,
        participants: [{ playerId: 7 }],
      },
    });
    assert.equal(values.get(TOKEN_KEY), token);
    assert.equal(readSession().status, "ready");
    assert.deepEqual(readSession().activeBossBattle, {
      battleId: "battle_1",
      bossId: 42,
      expiresAtUtc: "2026-10-24T12:00:00Z",
      remainingSeconds: 60,
    });
    assert.equal(values.has("madhouse.wiki.active-boss-battle"), false);
    assert.equal(Object.hasOwn(readSession(), "token"), false);
    const request = authorizeRequest({
      url: "/api/floors",
      headers: { authorization: "obsolete", Accept: "application/json" },
    });
    assert.deepEqual(request.headers, {
      Accept: "application/json",
      Authorization: "Bearer " + token,
    });
    assert.throws(() =>
      authorizeRequest({ url: "https://example.org/api/floors" }),
    );
    assert.equal(
      authorizeRequest({ url: "/api-docs/openapi.readonly.json" }).headers,
      undefined,
    );
    localStorage.setItem(TOKEN_KEY, jwt({ exp: 1 }));
    assert.equal(readSession().status, "expired");
    assert.throws(() => authorizeRequest({ url: "/api/floors" }));
    clearToken();
    assert.equal(readSession().status, "empty");
    assert.equal(readSession().activeBossBattle, null);
    assert.equal(changes, 2);
    assert.throws(() => authorizeRequest({ url: "/api/floors" }));
    unsubscribe();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("Telegram account switch clears the old JWT before any API request, including legacy unbound tokens", async () => {
  const previous = globalThis.window;
  const values = new Map();
  const target = new EventTarget();
  const launch = (id) =>
    "#tgWebAppData=" +
    encodeURIComponent(new URLSearchParams({ user: JSON.stringify({ id }) }));
  globalThis.window = {
    localStorage: {
      getItem: (k) => values.get(k) ?? null,
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    },
    location: { origin: "https://wiki.example", hash: launch(42) },
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  try {
    const value = jwt({ exp: Date.now() / 1000 + 600 });
    values.set(TOKEN_KEY, value);
    assert.equal(readSession().status, "empty");
    saveToken(value);
    assert.equal(readSession().status, "ready");
    window.location.hash = launch(99);
    assert.throws(() => authorizeRequest({ url: "/api/me" }));
    assert.equal(readSession().status, "empty");
    assert.equal(values.has(TOKEN_KEY), false);
  } finally {
    globalThis.window = previous;
  }
});

test("WebViews without localStorage can use a document-local JWT and still isolate Telegram accounts", () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  globalThis.window = {
    localStorage: {
      getItem() {
        throw new DOMException("denied", "SecurityError");
      },
      setItem() {
        throw new DOMException("denied", "SecurityError");
      },
      removeItem() {
        throw new DOMException("denied", "SecurityError");
      },
    },
    location: {
      origin: "https://wiki.example",
      hash: "#tgWebAppData=" + encodeURIComponent('user={"id":42}'),
    },
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  try {
    saveToken(jwt({ exp: Date.now() / 1000 + 600 }));
    assert.equal(readSession().status, "ready");
    assert.ok(authorizeRequest({ url: "/api/me" }).headers.Authorization);
    window.location.hash =
      "#tgWebAppData=" + encodeURIComponent('user={"id":99}');
    assert.equal(readSession().status, "empty");
    clearToken();
  } finally {
    globalThis.window = previous;
  }
});

test("an independent Wiki session authorizes only stored reads after game expiry", () => {
  const previous = globalThis.window;
  const realNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  const target = new EventTarget();
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: {
      origin: "https://wiki.example",
      hash:
        "#tgWebAppData=" +
        encodeURIComponent('auth_date=1&user={"id":42}&hash=' + "a".repeat(64)),
    },
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  try {
    clearToken();
    saveToken(jwt({ exp: 5 }));
    saveWikiSession("wiki-session-secret", {
      expiresAt: 9000,
      gameConnection: "connected",
    });
    assert.equal(readSession().gameConnection, "connected");
    now = 6000;
    const session = readSession();
    assert.equal(session.status, "expired");
    assert.equal(session.wikiSessionReady, true);
    assert.equal(session.gameConnection, "login-required");
    assert.throws(() => authorizeRequest({ url: "/api/me" }));
    assert.equal(
      authorizeStoredRequest({ url: "/api/me", method: "GET" }).headers
        .Authorization,
      "Bearer wiki-session-secret",
    );
    assert.equal(
      authorizeStoredRequest({
        url: "/api/automation/state",
        method: "GET",
      }).headers.Authorization,
      "Bearer wiki-session-secret",
    );
    const localCommands = [
      "auto.stop",
      "goal.stop",
      "raid.stop",
      "floor.stop",
      "work.stop",
      "character.stop",
      "business.run.stop",
      "subscription.stop",
      "buddy.stop",
      "queue.cancel",
    ];
    for (const command of localCommands) {
      const request = {
        url: "/api/automation/commands",
        method: "POST",
        headers: { Authorization: "stale-game-token" },
      };
      assert.equal(isLocalAutomationCommand(request, command), true, command);
      assert.equal(
        authorizeLocalAutomationCommand(request, command).headers.Authorization,
        "Bearer wiki-session-secret",
      );
    }
    for (const [request, command] of [
      [{ url: "/api/automation/commands?x=1", method: "POST" }, "work.stop"],
      [{ url: "/api/automation/commands", method: "GET" }, "work.stop"],
      [{ url: "/api/automation/commands", method: "POST" }, "queue.enqueue"],
      [{ url: "/api/me", method: "POST" }, "work.stop"],
    ]) {
      assert.equal(isLocalAutomationCommand(request, command), false);
      assert.throws(() => authorizeLocalAutomationCommand(request, command));
    }
    assert.throws(() =>
      authorizeRequest({ url: "/api/automation/state", method: "GET" }),
    );
    assert.throws(() =>
      authorizeStoredRequest({
        url: "/api/automation/state",
        method: "POST",
      }),
    );
    assert.throws(() =>
      authorizeStoredRequest({
        url: "/api/automation/commands",
        method: "POST",
      }),
    );
    assert.throws(() =>
      authorizeStoredRequest({ url: "/api/automation/bosses", method: "GET" }),
    );
    assert.equal(
      storedSessionIdentity().includes("wiki-session-secret"),
      false,
    );
    now = 10_000;
    assert.equal(readSession().wikiSessionReady, false);
    assert.throws(() => authorizeStoredRequest({ url: "/api/me" }));
  } finally {
    clearToken();
    Date.now = realNow;
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("local stop authorization falls back to a valid game JWT without Wiki session", () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    location: { origin: "https://wiki.example", hash: "" },
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  try {
    clearToken();
    const gameToken = jwt({ exp: Date.now() / 1000 + 60 });
    saveToken(gameToken);
    assert.equal(
      authorizeLocalAutomationCommand(
        { url: "/api/automation/commands", method: "POST" },
        "work.stop",
      ).headers.Authorization,
      `Bearer ${gameToken}`,
    );
  } finally {
    clearToken();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test("a Telegram account switch clears the in-memory Wiki-only principal", () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  const launch = (id) =>
    "#tgWebAppData=" +
    encodeURIComponent(
      new URLSearchParams({
        user: JSON.stringify({ id }),
        auth_date: "1",
        hash: "a".repeat(64),
      }),
    );
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    location: { origin: "https://wiki.example", hash: launch(42) },
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  try {
    clearToken();
    saveWikiSession("account-42-wiki-session", {
      expiresAt: Date.now() + 60000,
      gameConnection: "login-required",
    });
    assert.equal(readSession().wikiSessionReady, true);
    window.location.hash = launch(99);
    assert.equal(readSession().wikiSessionReady, false);
    assert.throws(() => authorizeStoredRequest({ url: "/api/me" }));
  } finally {
    clearToken();
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
