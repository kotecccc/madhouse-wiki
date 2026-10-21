import test from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "../connector/session.js";
import { createMessageGate, CHANNEL, VERSION } from "../connector/protocol.js";
import {
  createConnectorBridge,
  telegramUserHint,
} from "../shared/telegram-connector.js";
import { createConnectorApi } from "../connector/game-auth-api.js";
import { productionConnectorConfig } from "../scripts/deploy/connector-release-config.mjs";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
test("release packaging refuses local, invalid or missing required connector origins", () => {
  for (const origin of [
    "http://127.0.0.1:4199",
    "https://localhost",
    "https://127.0.0.1",
    "https://connect.example/?token=bad",
  ])
    assert.throws(() =>
      productionConnectorConfig({ origin, protocolVersion: 1 }),
    );
  assert.throws(() =>
    productionConnectorConfig({ origin: null, protocolVersion: 1 }, true),
  );
  assert.deepEqual(
    productionConnectorConfig(
      { origin: "https://connect.example", protocolVersion: 1 },
      true,
    ),
    { origin: "https://connect.example", protocolVersion: 1 },
  );
});
const launch =
  "https://cargohustle.online/#tgWebAppData=" +
  encodeURIComponent("auth_date=1&hash=" + "a".repeat(64) + "&user=%7B%7D");
function client(overrides = {}) {
  return {
    getMe: async () => ({ id: 42 }),
    openWebview: async () => ({ url: launch }),
    logOut: async () => {},
    notifyLoggedOut: async () => {},
    destroy: async () => {},
    ...overrides,
  };
}
test("connection exchanges once per flight, requests a new launch for renewal, checks account", async () => {
  let launches = 0,
    exchanges = 0;
  const conn = createConnection({
    createClient: () =>
      client({
        openWebview: async () => {
          launches++;
          return { url: launch };
        },
      }),
    exchange: async () => {
      exchanges++;
      return "fresh-game-token";
    },
  });
  const result = await Promise.all([
    conn.gameLogin("42"),
    conn.gameLogin("42"),
  ]);
  assert.equal(result[0].accessToken, "fresh-game-token");
  assert.equal(launches, 1);
  assert.equal(exchanges, 1);
  await conn.gameLogin("42");
  assert.equal(launches, 2);
  assert.equal(exchanges, 2);
  assert.equal((await conn.gameLogin("99")).status, "login-required");
  assert.equal(exchanges, 2);
});
test("logout invalidates a pending login and reports a remote failure separately", async () => {
  let release,
    cleared = false;
  const conn = createConnection({
    createClient: () =>
      client({
        logOut: async () => {
          throw new Error("network");
        },
        notifyLoggedOut: async () => {
          cleared = true;
        },
      }),
    exchange: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const old = conn.gameLogin();
  const rejected = assert.rejects(old, /cancelled/);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const result = await conn.logout();
  assert.equal(result.remoteRevoked, false);
  assert.equal(result.localCleared, true);
  assert.equal(cleared, true);
  release("must-not-reach-wiki");
  await rejected;
});
test("a deferred getMe cannot restore connected state after logout", async () => {
  let release;
  const states = [];
  const conn = createConnection({
    createClient: () =>
      client({
        getMe: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      }),
    exchange: async () => "never",
    onState: (value) => states.push(value.stage),
  });
  const old = conn.gameLogin("42");
  const rejected = assert.rejects(old, /cancelled/);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await conn.logout();
  release({ id: 42 });
  await rejected;
  assert.equal(states.includes("connected"), false);
  assert.equal(conn.account, null);
});
test("cancelled signIn is allowed to settle, then its late grant is revoked", async () => {
  let release;
  const events = [];
  const conn = createConnection({
    createClient: () =>
      client({
        signIn: () =>
          new Promise((resolve) => {
            release = () => {
              events.push("granted");
              resolve({ id: 42 });
            };
          }),
        logOut: async () => {
          events.push("revoked");
        },
      }),
    exchange: async () => "never",
  });
  const signing = conn.signIn("test-phone", "test-hash", "test-code");
  const rejected = assert.rejects(signing, /cancelled/);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const revoking = conn.logout();
  release();
  assert.equal((await revoking).remoteRevoked, true);
  await rejected;
  assert.deepEqual(events, ["granted", "revoked"]);
});
test("cancelled QR watches its still-valid token and revokes a late approval", async () => {
  let clock = 0,
    revoked = false;
  const conn = createConnection({
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    createClient: () =>
      client({
        getMe: async () => {
          if (clock < 2000) throw { text: "AUTH_KEY_UNREGISTERED" };
          return { id: 42 };
        },
        logOut: async () => {
          revoked = true;
        },
      }),
    exchange: async () => "never",
  });
  await conn.runAuth(async () => ({ _: "auth.loginToken", expires: 2 }));
  assert.equal((await conn.logout()).remoteRevoked, true);
  assert.equal(clock, 2000);
  assert.equal(revoked, true);
});
test("logout never claims local key removal when storage cleanup fails", async () => {
  const conn = createConnection({
    createClient: () =>
      client({
        logOut: async () => {
          throw new Error();
        },
        notifyLoggedOut: async () => {
          throw new Error();
        },
      }),
    exchange: async () => "never",
  });
  const result = await conn.logout();
  assert.equal(result.remoteRevoked, false);
  assert.equal(result.localCleared, false);
});
test("a QR with an unusually long validity yields an unknown revoke result after bounded monitoring", async () => {
  let clock = 0;
  const unregistered = async () => {
    throw { text: "AUTH_KEY_UNREGISTERED" };
  };
  const conn = createConnection({
    now: () => clock,
    pause: async (ms) => {
      clock += ms;
    },
    createClient: () => client({ getMe: unregistered, logOut: unregistered }),
    exchange: async () => "never",
  });
  await conn.runAuth(async () => ({ _: "auth.loginToken", expires: 300 }));
  const result = await conn.logout();
  assert.equal(clock, 120000);
  assert.equal(result.remoteRevoked, false);
  assert.equal(result.localCleared, true);
});
test("account hint works without the Telegram SDK and rejects malformed launch data", () => {
  const hash =
    "#tgWebAppData=" +
    encodeURIComponent(
      new URLSearchParams({ user: JSON.stringify({ id: 42 }) }),
    );
  assert.equal(telegramUserHint({ location: { hash } }), "42");
  assert.equal(telegramUserHint({ location: { hash: "#top" } }), undefined);
  assert.equal(
    telegramUserHint({
      Telegram: { WebApp: { initDataUnsafe: { user: { id: -1 } } } },
    }),
    undefined,
  );
});
test("message gate rejects wrong origin, wrong source, RPC fields and replay", () => {
  const parent = {},
    data = {
      channel: CHANNEL,
      version: VERSION,
      id: uuid(1),
      action: "connect-game",
    };
  const gate = createMessageGate({ parent, origins: ["https://wiki.example"] });
  assert.equal(
    gate({ source: parent, origin: "https://wrong.example", data }),
    false,
  );
  assert.equal(
    gate({ source: {}, origin: "https://wiki.example", data }),
    false,
  );
  assert.equal(
    gate({
      source: parent,
      origin: "https://wiki.example",
      data: { ...data, rpc: "messages.sendMessage" },
    }),
    false,
  );
  assert.equal(
    gate({ source: parent, origin: "https://wiki.example", data }),
    true,
  );
  assert.equal(
    gate({ source: parent, origin: "https://wiki.example", data }),
    false,
  );
});
test("parent bridge accepts only exact child, ignores stale token after logout", async () => {
  let receiver,
    serial = 0;
  const sent = [];
  const child = { postMessage: (data, origin) => sent.push({ data, origin }) };
  const bridge = createConnectorBridge({
    origin: "https://connect.example",
    source: () => child,
    listen: (fn) => {
      receiver = fn;
    },
    unlisten: () => {},
    randomId: () => uuid(++serial),
  });
  const emit = (data, origin = "https://connect.example", source = child) =>
    receiver({
      data: { channel: CHANNEL, version: VERSION, ...data },
      origin,
      source,
    });
  emit({ kind: "ready" }, "https://wrong.example");
  assert.equal(sent.length, 0);
  emit({ kind: "ready" });
  const pending = bridge.request("connect-game");
  const rejected = assert.rejects(pending, /cancelled/);
  const loginId = sent[0].data.id;
  const loggedOut = bridge.request("logout");
  emit({
    kind: "result",
    id: loginId,
    status: "connected",
    accessToken: "stale-token",
  });
  const logoutId = sent.at(-1).data.id;
  emit(
    {
      kind: "result",
      id: logoutId,
      status: "disconnected",
      remoteRevoked: true,
      localCleared: true,
    },
    "https://connect.example",
    {},
  );
  emit({
    kind: "result",
    id: logoutId,
    status: "disconnected",
    remoteRevoked: true,
    localCleared: true,
  });
  assert.equal((await loggedOut).remoteRevoked, true);
  await rejected;
  assert.ok(sent.every((item) => item.origin === "https://connect.example"));
  bridge.destroy();
});
test("bridge timeout cancels the child flow and a failed exchange can start with a new nonce", async () => {
  let receive,
    serial = 0;
  const sent = [];
  const child = { postMessage: (data) => sent.push(data) };
  const bridge = createConnectorBridge({
    origin: "https://connect.example",
    source: () => child,
    listen: (fn) => {
      receive = fn;
    },
    unlisten: () => {},
    randomId: () => uuid(++serial),
    timeout: 5,
  });
  const emit = (data) =>
    receive({
      origin: "https://connect.example",
      source: child,
      data: { channel: CHANNEL, version: VERSION, ...data },
    });
  emit({ kind: "ready" });
  await assert.rejects(
    bridge.request("connect-game", { interactive: true }),
    /connection_timeout/,
  );
  assert.equal(sent.at(-1).action, "cancel");
  const retry = bridge.request("connect-game");
  emit({ id: sent.at(-1).id, kind: "result", status: "failed" });
  await assert.rejects(retry, /connection_failed/);
  const next = bridge.request("connect-game");
  const id = sent.at(-1).id;
  emit({
    id,
    kind: "result",
    status: "connected",
    accessToken: "fresh-game-token",
  });
  assert.equal((await next).accessToken, "fresh-game-token");
  bridge.destroy();
});
test("auth relay has one fixed POST destination, strips old credentials, returns no profile", async () => {
  let call;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: [],
    fetcher: async (url, options) => {
      call = { url, options };
      return new Response(
        JSON.stringify({
          accessToken: "header.payload.signature",
          player: { private: true },
          wallet: {},
        }),
      );
    },
  });
  const initData = "hash=" + "a".repeat(64) + "&auth_date=1&user=%7B%7D";
  const request = (origin, body = { initData }) =>
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: "Bearer old",
        Cookie: "old=1",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await api(request("https://attacker.example"))).status, 403);
  assert.equal(
    (
      await api(
        request("https://connect.example", {
          initData,
          destination: "https://attacker.example",
        }),
      )
    ).status,
    400,
  );
  const response = await api(request("https://connect.example"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    accessToken: "header.payload.signature",
  });
  assert.equal(call.url, "https://cargohustle.online/api/auth/telegram");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.credentials, "omit");
  assert.deepEqual(Object.keys(call.options.headers).sort(), [
    "Accept",
    "Content-Type",
  ]);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("WebView IndexedDB InvalidStateError falls back once to an independent memory client", async () => {
  let persistent = 0,
    memory = 0;
  const conn = createConnection({
    createClient: () => {
      persistent++;
      return client({
        getMe: async () => {
          throw new DOMException("private-storage-detail", "InvalidStateError");
        },
      });
    },
    createMemoryClient: () => {
      memory++;
      return client({
        getMe: async () => {
          throw { text: "AUTH_KEY_UNREGISTERED" };
        },
      });
    },
    exchange: () =>
      assert.fail("unauthenticated memory client must not request game auth"),
  });
  assert.deepEqual(await conn.gameLogin("42"), { status: "login-required" });
  assert.equal(persistent, 1);
  assert.equal(memory, 1);
  await conn.restore("42");
  assert.equal(memory, 1);
});

test("account-specific Telegram stores never restore the previous account after switching", async () => {
  const names = [];
  const conn = createConnection({
    createClient: (name) => {
      names.push(name);
      return client({
        getMe: async () => ({ id: name.endsWith("-99") ? 99 : 42 }),
      });
    },
    exchange: async () => "token",
  });
  await conn.gameLogin("42");
  await conn.gameLogin("99");
  assert.equal(names.length, 2);
  assert.ok(names[0].endsWith("-42"));
  assert.ok(names[1].endsWith("-99"));
});
