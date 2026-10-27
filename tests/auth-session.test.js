import assert from "node:assert/strict";
import test from "node:test";
import {
  saveServerManagedSession,
  readSession,
  clearToken,
  authorizeRequest,
  formatExpiry,
  TOKEN_KEY,
  TOKEN_OWNER_KEY,
  subscribeSession,
} from "../shared/auth-session.js";

const launch = (id) =>
  "#tgWebAppData=" +
  encodeURIComponent(
    new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id }),
      hash: "signed-launch",
    }),
  );

function installWindow({
  hash = "",
  stored = new Map(),
  denyStorage = false,
} = {}) {
  const previous = globalThis.window;
  const target = new EventTarget();
  const localStorage = denyStorage
    ? {
        getItem() {
          throw new DOMException("denied", "SecurityError");
        },
        setItem() {
          throw new DOMException("denied", "SecurityError");
        },
        removeItem() {
          throw new DOMException("denied", "SecurityError");
        },
      }
    : {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
        removeItem: (key) => stored.delete(key),
      };
  globalThis.window = {
    localStorage,
    location: { origin: "https://wiki.example", hash },
    dispatchEvent: target.dispatchEvent.bind(target),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  return {
    previous,
    stored,
    restore() {
      if (previous === undefined) delete globalThis.window;
      else globalThis.window = previous;
    },
  };
}

test("legacy browser JWTs are erased and never authorize Wiki requests", () => {
  const stored = new Map([
    [TOKEN_KEY, "header.payload.legacy-secret"],
    [TOKEN_OWNER_KEY, "42"],
  ]);
  const browser = installWindow({ stored });
  try {
    assert.deepEqual(readSession(), {
      status: "empty",
      expiresAt: null,
      identity: null,
      activeBossBattle: null,
    });
    assert.equal(stored.has(TOKEN_KEY), false);
    assert.equal(stored.has(TOKEN_OWNER_KEY), false);
    assert.throws(() => authorizeRequest({ url: "/api/me" }), /Telegram/u);
    assert.equal(
      formatExpiry(readSession()),
      "Подключите игровой аккаунт через Telegram",
    );
  } finally {
    browser.restore();
  }
});

test("server-managed Wiki session sends signed owner proof and strips every Bearer", () => {
  const stored = new Map([
    [TOKEN_KEY, "header.payload.old-secret"],
    [TOKEN_OWNER_KEY, "42"],
  ]);
  const initData = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42 }),
    hash: "signed-launch",
  }).toString();
  const browser = installWindow({ hash: launch(42), stored });
  try {
    saveServerManagedSession("42");
    const session = readSession();
    assert.equal(session.status, "ready");
    assert.equal(session.serverManaged, true);
    assert.match(session.identity, /^telegram:42:\d+$/u);
    assert.equal(Object.hasOwn(session, "token"), false);
    assert.equal(formatExpiry(session), "Сеанс хранится в Wiki");
    assert.equal(stored.size, 0);
    assert.throws(() => saveServerManagedSession("99"));

    const request = authorizeRequest({
      url: "/api/me",
      headers: {
        Authorization: "stale.browser.token",
        "X-Madhouse-Wiki-Init-Data": "stale.owner.proof",
        Accept: "application/json",
      },
    });
    assert.deepEqual(request.headers, {
      Accept: "application/json",
      "X-Madhouse-Wiki-Init-Data": initData,
    });
    assert.throws(() =>
      authorizeRequest({ url: "https://example.org/api/me" }),
    );
    assert.equal(
      authorizeRequest({ url: "/api-docs/openapi.readonly.json" }).headers,
      undefined,
    );
    clearToken();
    assert.equal(readSession().status, "empty");
    saveServerManagedSession("42");
    assert.notEqual(readSession().identity, session.identity);
    clearToken();
  } finally {
    browser.restore();
  }
});

test("changing the Telegram owner clears the server-managed browser session", () => {
  const browser = installWindow({ hash: launch(42) });
  try {
    saveServerManagedSession("42");
    assert.equal(readSession().status, "ready");
    window.location.hash = launch(99);
    assert.equal(readSession().status, "empty");
    assert.throws(() => authorizeRequest({ url: "/api/me" }), /Telegram/u);
  } finally {
    browser.restore();
  }
});

test("server-managed proof works when browser storage is unavailable", () => {
  const browser = installWindow({ hash: launch(42), denyStorage: true });
  try {
    saveServerManagedSession("42");
    assert.equal(readSession().status, "ready");
    assert.deepEqual(authorizeRequest({ url: "/api/me" }).headers, {
      "X-Madhouse-Wiki-Init-Data": new URLSearchParams(
        decodeURIComponent(launch(42).slice("#tgWebAppData=".length)),
      ).toString(),
    });
    clearToken();
    assert.equal(readSession().status, "empty");
  } finally {
    browser.restore();
  }
});

test("auth listeners observe server session changes and legacy key cleanup", () => {
  const stored = new Map([[TOKEN_KEY, "header.payload.old-secret"]]);
  const browser = installWindow({ hash: launch(42), stored });
  try {
    let changes = 0;
    const unsubscribe = subscribeSession(() => changes++);
    saveServerManagedSession("42");
    assert.equal(changes, 1);
    assert.equal(stored.size, 0);
    clearToken();
    assert.equal(changes, 2);
    unsubscribe();
  } finally {
    browser.restore();
  }
});
