import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createConnection } from "../connector/session.js";
import {
  createMessageGate,
  validRequest,
  CHANNEL,
  VERSION,
} from "../connector/protocol.js";
import {
  createConnectorBridge,
  telegramUserHint,
} from "../shared/telegram-connector.js";
import { createConnectorApi as createConnectorApiImpl } from "../connector/game-auth-api.js";
import { productionConnectorConfig } from "../scripts/deploy/connector-release-config.mjs";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wikiVerificationKey = "11".repeat(32);
const signedWikiInitData = (id = 42, issuedAtMs = Date.now()) => {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(issuedAtMs / 1000)),
    user: JSON.stringify({ id }),
    signature: "synthetic-wiki-signature-field",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  params.set(
    "hash",
    createHmac("sha256", Buffer.from(wikiVerificationKey, "hex"))
      .update(check)
      .digest("hex"),
  );
  return params.toString();
};
const gameInitData = (id = 42) =>
  `hash=${"a".repeat(64)}&auth_date=1&user=${encodeURIComponent(JSON.stringify({ id }))}`;
const createConnectorApi = (options = {}) =>
  createConnectorApiImpl({ wikiVerificationKey, ...options });
test("restore request identity is accepted only for interactive game connections", async () => {
  const base = {
    channel: CHANNEL,
    version: VERSION,
    id: uuid(1),
    action: "connect-game",
    interactive: true,
    wikiInitData: "proof",
    restoreRequestId: uuid(2),
  };
  assert.equal(validRequest(base), true);
  assert.equal(validRequest({ ...base, interactive: false }), false);
  assert.equal(validRequest({ ...base, action: "status" }), false);
  assert.equal(validRequest({ ...base, restoreRequestId: "invalid" }), false);
  const bridge = createConnectorBridge({
    origin: "https://connect.example",
    source: () => ({ postMessage() {} }),
    listen: () => {},
    unlisten: () => {},
    randomId: () => uuid(3),
  });
  await assert.rejects(
    bridge.request("connect-game", {
      interactive: false,
      restoreRequestId: uuid(2),
    }),
    /invalid_action/u,
  );
  bridge.destroy();
});
test("interactive restore message carries the confirmed request identity", async () => {
  let receiver;
  const sent = [];
  const child = { postMessage: (data) => sent.push(data) };
  const bridge = createConnectorBridge({
    origin: "https://connect.example",
    source: () => child,
    listen: (fn) => {
      receiver = fn;
    },
    unlisten: () => {},
    randomId: () => uuid(3),
  });
  receiver({
    origin: "https://connect.example",
    source: child,
    data: { channel: CHANNEL, version: VERSION, kind: "ready" },
  });
  const promise = bridge.request("connect-game", {
    interactive: true,
    expectedUserId: "42",
    wikiInitData: "proof",
    restoreRequestId: uuid(2),
  });
  assert.equal(sent[0].restoreRequestId, uuid(2));
  assert.equal(validRequest(sent[0]), true);
  receiver({
    origin: "https://connect.example",
    source: child,
    data: {
      channel: CHANNEL,
      version: VERSION,
      id: sent[0].id,
      kind: "result",
      status: "connected",
      serverManaged: true,
    },
  });
  assert.equal((await promise).status, "connected");
  bridge.destroy();
});
test("release packaging refuses local, invalid or missing required connector origins", () => {
  for (const origin of [
    "http://127.0.0.1:4199",
    "https://localhost",
    "https://127.0.0.1",
    "https://connect.example/?token=bad",
  ])
    assert.throws(() =>
      productionConnectorConfig({ origin, protocolVersion: VERSION }),
    );
  assert.throws(() =>
    productionConnectorConfig({ origin: null, protocolVersion: VERSION }, true),
  );
  assert.deepEqual(
    productionConnectorConfig(
      { origin: "https://connect.example", protocolVersion: VERSION },
      true,
    ),
    { origin: "https://connect.example", protocolVersion: VERSION },
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
test("connection exchanges once per flight into a server-managed session", async () => {
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
      return { serverManaged: true };
    },
  });
  const result = await Promise.all([
    conn.gameLogin("42"),
    conn.gameLogin("42"),
  ]);
  assert.deepEqual(result[0], { status: "connected", serverManaged: true });
  assert.equal(launches, 1);
  assert.equal(exchanges, 1);
  await conn.gameLogin("42");
  assert.equal(launches, 2);
  assert.equal(exchanges, 2);
  assert.equal((await conn.gameLogin("99")).status, "login-required");
  assert.equal(exchanges, 2);
});
test("connector refuses to return a Cargo credential from its auth exchange", async () => {
  const conn = createConnection({
    createClient: () => client(),
    exchange: async () => ({ accessToken: "private-game-jwt" }),
  });
  await assert.rejects(
    conn.gameLogin("42"),
    /game_auth_server_managed_required/u,
  );
});
test("pending restore exchange propagates pending without issuing another launch", async () => {
  let launches = 0;
  let exchanges = 0;
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
      return { status: "pending" };
    },
  });
  assert.deepEqual(await conn.gameLogin("42"), { status: "pending" });
  assert.equal(launches, 1);
  assert.equal(exchanges, 1);
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
  const phone = "+12025550123";
  const conn = createConnection({
    createClient: () =>
      client({
        getApiCredentials: async () => ({ id: 42, hash: "test-api-hash" }),
        call: async (request) => {
          if (request._ === "auth.sendCode")
            return {
              _: "auth.sentCode",
              phoneCodeHash: "test-hash",
              timeout: 0,
              nextType: { _: "auth.codeTypeSms" },
              type: { _: "auth.sentCodeTypeSms", length: 6 },
            };
          if (request._ === "auth.signIn")
            return new Promise((resolve) => {
              release = () =>
                resolve({ _: "auth.authorization", user: { id: 42 } });
            });
          throw new Error("unexpected auth method");
        },
        notifyLoggedIn: async () => {
          events.push("granted");
          return { id: 42 };
        },
        logOut: async () => {
          events.push("revoked");
        },
      }),
    exchange: async () => "never",
  });
  const sent = await conn.phoneCode(phone);
  const signing = conn.signIn(phone, sent.challenge, "123456");
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
    serverManaged: true,
  });
  const connected = await next;
  assert.deepEqual(connected, {
    status: "connected",
    serverManaged: true,
    remoteRevoked: false,
    localCleared: false,
  });
  bridge.destroy();
});
test("restore relay preserves the confirmed request identity and never retries an uncertain exchange", async () => {
  const calls = [];
  let fail = false;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (fail) throw new Error("synthetic disconnect");
      return Response.json({
        operation: "restore.exchange",
        requestId: uuid(88),
        status: "review_required",
      });
    },
  });
  const makeRequest = (id = 42) =>
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "restore",
        initData: gameInitData(id),
        wikiInitData: signedWikiInitData(),
        restoreRequestId: uuid(88),
      }),
    });
  assert.equal((await api(makeRequest(43))).status, 409);
  assert.equal(calls.length, 0);
  const ok = await api(makeRequest());
  assert.deepEqual(await ok.json(), {
    status: "connected",
    serverManaged: true,
  });
  assert.equal(calls[0].body.requestId, uuid(88));
  assert.equal(calls[0].body.operation, "restore.exchange");
  fail = true;
  const unknown = await api(makeRequest());
  assert.deepEqual(await unknown.json(), { error: "game_auth_unknown" });
  assert.equal(calls.length, 2);
});

test("auth relay has one fixed POST destination, strips old credentials, returns no profile", async () => {
  const wikiCalls = [];
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (url, options) => {
      const body = JSON.parse(options.body);
      wikiCalls.push({ url, options, body });
      if (body.operation === "device.list")
        return Response.json({
          requestId: body.requestId,
          operation: body.operation,
          devices: [],
          routePolicy: null,
        });
      return Response.json({
        requestId: body.requestId,
        operation: body.operation,
        operationId: uuid(77),
        status: "ready",
      });
    },
  });
  const initData = gameInitData();
  const wikiInitData = signedWikiInitData();
  const request = (origin, body = { initData, wikiInitData }) =>
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
          wikiInitData,
          destination: "https://attacker.example",
        }),
      )
    ).status,
    400,
  );
  const response = await api(request("https://connect.example"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    status: "connected",
    serverManaged: true,
  });
  assert.deepEqual(
    wikiCalls.map(({ body }) => body.operation),
    ["device.list", "game_auth.bootstrap"],
  );
  const bootstrap = wikiCalls[1];
  assert.equal(bootstrap.url, "https://wiki.example/api/bridge");
  assert.equal(bootstrap.options.headers.Origin, "https://wiki.example");
  assert.equal(bootstrap.options.credentials, "omit");
  assert.equal(bootstrap.body.cargoLaunchData, initData);
  assert.equal(bootstrap.body.initData, wikiInitData);
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.match(response.headers.get("cache-control"), /no-store/);
});

test("Connector refuses direct game auth when the Wiki owner selected the bridge route", async () => {
  const cargoCalls = [];
  let wikiCall;
  const wikiInitData = signedWikiInitData();
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (url, options) => {
      wikiCall = { url, options };
      return Response.json({
        requestId: JSON.parse(options.body).requestId,
        operation: "device.list",
        devices: [],
        routePolicy: {
          policy: "bridge_required",
          activeDeviceId: "00000000-0000-4000-8000-000000000001",
          routeEpoch: 3,
        },
      });
    },
    fetcher: async (...args) => {
      cargoCalls.push(args);
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData,
      }),
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "bridge_auth_required" });
  assert.equal(wikiCall.url, "https://wiki.example/api/bridge");
  assert.equal(wikiCall.options.headers.Origin, "https://wiki.example");
  assert.equal(JSON.parse(wikiCall.options.body).initData, wikiInitData);
  assert.equal(cargoCalls.length, 0);
});

test("game auth requires a Wiki identity proof before Cargo can receive launch data", async () => {
  let cargoCalls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async () => {
      assert.fail("Wiki route check must not run without a proof");
    },
    fetcher: async () => {
      cargoCalls += 1;
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
      }),
    }),
  );
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "invalid_wiki_identity" });
  assert.equal(cargoCalls, 0);
});

test("game auth fails closed when the local Wiki identity verifier is unavailable", async () => {
  let wikiCalls = 0;
  let cargoCalls = 0;
  const api = createConnectorApi({
    wikiVerificationKey: "",
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async () => {
      wikiCalls += 1;
      return Response.json({});
    },
    fetcher: async () => {
      cargoCalls += 1;
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData: signedWikiInitData(),
      }),
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "bridge_route_unavailable",
  });
  assert.equal(wikiCalls, 0);
  assert.equal(cargoCalls, 0);
});

test("Cargo launch identity must match the signed Wiki owner before any route lookup or issuance", async () => {
  let wikiCalls = 0;
  let cargoCalls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async () => {
      wikiCalls += 1;
      throw new Error("mismatched launch must stop before route lookup");
    },
    fetcher: async () => {
      cargoCalls += 1;
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(99),
        wikiInitData: signedWikiInitData(42),
      }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "game_account_mismatch" });
  assert.equal(wikiCalls, 0);
  assert.equal(cargoCalls, 0);
});

test("stale or tampered signed Wiki launch data fails before route lookup and Cargo", async () => {
  for (const wikiInitData of [
    signedWikiInitData(42, Date.now() - 301_000),
    signedWikiInitData().replace(
      /hash=[a-f0-9]{64}/u,
      `hash=${"0".repeat(64)}`,
    ),
  ]) {
    let wikiCalls = 0;
    let cargoCalls = 0;
    const api = createConnectorApi({
      appParams: async () => ({}),
      wikiOrigins: ["https://wiki.example"],
      wikiFetcher: async () => {
        wikiCalls += 1;
        return Response.json({});
      },
      fetcher: async () => {
        cargoCalls += 1;
        return Response.json({ accessToken: "header.payload.signature" });
      },
    });
    const response = await api(
      new Request("https://connect.example/api/game-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ initData: gameInitData(), wikiInitData }),
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "invalid_wiki_identity" });
    assert.equal(wikiCalls, 0);
    assert.equal(cargoCalls, 0);
  }
});

test("Connector fails closed when it cannot verify the Wiki route before direct auth", async () => {
  let cargoCalls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async () => {
      throw new Error("wiki_network_unavailable");
    },
    fetcher: async () => {
      cargoCalls += 1;
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData: signedWikiInitData(),
      }),
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "bridge_route_unavailable",
  });
  assert.equal(cargoCalls, 0);
});

test("Connector rejects an uncorrelated Wiki owner-route response", async () => {
  let cargoCalls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async () =>
      Response.json({
        requestId: "00000000-0000-4000-8000-000000000001",
        operation: "device.list",
        devices: [],
        routePolicy: null,
      }),
    fetcher: async () => {
      cargoCalls += 1;
      return Response.json({ accessToken: "header.payload.signature" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData: signedWikiInitData(),
      }),
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "bridge_route_unavailable",
  });
  assert.equal(cargoCalls, 0);
});

test("Wiki route status, redirect, and malformed responses fail closed before Cargo", async () => {
  const cases = [
    {
      response: new Response("", { status: 401 }),
      status: 401,
      error: "invalid_wiki_identity",
    },
    {
      response: new Response("", { status: 429 }),
      status: 429,
      error: "try_later",
    },
    {
      response: new Response("", { status: 503 }),
      status: 503,
      error: "bridge_route_unavailable",
    },
    {
      response: Response.redirect("https://other.example/"),
      status: 503,
      error: "bridge_route_unavailable",
    },
    {
      response: new Response("not-json"),
      status: 503,
      error: "bridge_route_unavailable",
    },
    {
      response: new Response("x".repeat(16 * 1024 + 1)),
      status: 503,
      error: "bridge_route_unavailable",
    },
  ];
  for (const fixture of cases) {
    let cargoCalls = 0;
    const api = createConnectorApi({
      appParams: async () => ({}),
      wikiOrigins: ["https://wiki.example"],
      wikiFetcher: async (_url, options) => {
        assert.equal(options.redirect, "error");
        assert.equal(options.credentials, "omit");
        assert.equal(options.cache, "no-store");
        assert.ok(options.signal instanceof AbortSignal);
        return fixture.response;
      },
      fetcher: async () => {
        cargoCalls += 1;
        return Response.json({ accessToken: "header.payload.signature" });
      },
    });
    const response = await api(
      new Request("https://connect.example/api/game-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          initData: gameInitData(),
          wikiInitData: signedWikiInitData(),
        }),
      }),
    );
    assert.equal(response.status, fixture.status);
    assert.deepEqual(await response.json(), { error: fixture.error });
    assert.equal(cargoCalls, 0);
  }
});

test("a verified direct Wiki route delegates auth to Wiki and returns only a server-managed status", async () => {
  let cargoCalls = 0;
  let bootstrapRequest;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.operation === "device.list")
        return Response.json({
          requestId: body.requestId,
          operation: body.operation,
          devices: [],
          routePolicy: {
            policy: "direct",
            activeDeviceId: null,
            routeEpoch: 0,
          },
        });
      bootstrapRequest = body;
      return Response.json({
        requestId: body.requestId,
        operation: body.operation,
        operationId: uuid(78),
        status: "ready",
      });
    },
    fetcher: async () => {
      cargoCalls++;
      return Response.json({ accessToken: "must-not-be-used" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData: signedWikiInitData(),
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "connected",
    serverManaged: true,
  });
  assert.equal(cargoCalls, 0);
  assert.equal(bootstrapRequest.operation, "game_auth.bootstrap");
  assert.equal(bootstrapRequest.cargoLaunchData, gameInitData());
});

test("game logout revokes the Wiki credential without reading or forwarding a JWT", async () => {
  const wikiCalls = [];
  let cargoCalls = 0;
  const wikiInitData = signedWikiInitData();
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      wikiCalls.push({ options, body });
      return Response.json({
        requestId: body.requestId,
        operation: body.operation,
        operationId: uuid(80),
        status: "logged_out",
      });
    },
    fetcher: async () => {
      cargoCalls++;
      return Response.json({ accessToken: "must-not-be-issued-by-Connector" });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "logout", wikiInitData }),
    }),
  );

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, { status: "disconnected", serverManaged: true });
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(wikiCalls.length, 1);
  assert.equal(wikiCalls[0].body.operation, "game_auth.logout");
  assert.equal(wikiCalls[0].body.initData, wikiInitData);
  assert.equal(Object.hasOwn(wikiCalls[0].body, "cargoLaunchData"), false);
  assert.equal(wikiCalls[0].options.signal instanceof AbortSignal, true);
  assert.equal(cargoCalls, 0);
});

test("game-session restore treats the durable logout tombstone as login-required", async () => {
  const wikiInitData = signedWikiInitData();
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.operation, "game_auth.bootstrap.status");
      return Response.json({
        requestId: body.requestId,
        operation: body.operation,
        operationId: uuid(81),
        status: "logged_out",
      });
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "status", wikiInitData }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "login-required" });
});

test("legacy account-session restore and save never read or persist Cargo JWTs", async () => {
  const cases = [
    ["restore", 200, { status: "login-required" }],
    ["save", 409, { error: "game_auth_server_managed_required" }],
  ];
  for (const [action, status, expected] of cases) {
    let accountSessionCalls = 0;
    let wikiCalls = 0;
    const api = createConnectorApi({
      appParams: async () => ({}),
      wikiOrigins: ["https://wiki.example"],
      wikiFetcher: async () => {
        wikiCalls += 1;
        assert.fail("legacy account sessions must not call Wiki or Cargo");
      },
      accountSessions: async () => {
        accountSessionCalls += 1;
        assert.fail("legacy restore and save must not read or persist records");
      },
    });
    const response = await api(
      new Request("https://connect.example/api/account-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          wikiInitData: signedWikiInitData(),
          wikiProof: "sealed-owner-proof",
          ticket: "1.synthetic-ticket",
          accessToken: "candidate.token.signature",
        }),
      }),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), expected);
    assert.equal(accountSessionCalls, 0);
    assert.equal(wikiCalls, 0);
  }
});

test("account-session logout remains available with its sealed Wiki proof", async () => {
  let accountSessionInput;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: [],
    wikiFetcher: async () => assert.fail("logout must not depend on Wiki"),
    accountSessions: async (data) => {
      accountSessionInput = data;
      return { status: "disconnected", wikiProof: "sealed-owner-proof" };
    },
  });
  const response = await api(
    new Request("https://connect.example/api/account-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "logout",
        wikiProof: "sealed-owner-proof",
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(accountSessionInput, {
    action: "logout",
    wikiProof: "sealed-owner-proof",
  });
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
    exchange: async () => ({ serverManaged: true }),
  });
  await conn.gameLogin("42");
  await conn.gameLogin("99");
  assert.equal(names.length, 2);
  assert.ok(names[0].endsWith("-42"));
  assert.ok(names[1].endsWith("-99"));
});

test("temporary game failures request fresh launches and never replay initData", async () => {
  let launches = 0;
  const exchanged = [];
  const conn = createConnection({
    createClient: () =>
      client({
        openWebview: async () => ({
          url: launch.replace("auth_date%3D1", `auth_date%3D${++launches}`),
        }),
      }),
    pause: async () => {},
    exchange: async (initData) => {
      exchanged.push(initData);
      if (exchanged.length < 3) throw new Error("game_unavailable");
      return { serverManaged: true };
    },
  });
  assert.deepEqual(await conn.gameLogin("42"), {
    status: "connected",
    serverManaged: true,
  });
  assert.equal(launches, 3);
  assert.equal(new Set(exchanged).size, 3);
});

test("repeated signed launches and permanent game rejection are not replayed", async () => {
  for (const category of ["game_unavailable", "game_auth_rejected"]) {
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
      pause: async () => {},
      exchange: async () => {
        exchanges++;
        throw new Error(category);
      },
    });
    await assert.rejects(conn.gameLogin("42"), new RegExp(category));
    assert.equal(exchanges, 1);
    assert.equal(launches, category === "game_unavailable" ? 3 : 1);
  }
});

test("cancellation stops recovery before requesting another signed launch", async () => {
  let launches = 0;
  const conn = createConnection({
    createClient: () =>
      client({
        openWebview: async () => {
          launches++;
          return { url: launch };
        },
      }),
    pause: async () => conn.cancel(),
    exchange: async () => {
      throw new Error("game_unavailable");
    },
  });
  await assert.rejects(conn.gameLogin("42"), /cancelled/);
  assert.equal(launches, 1);
});

test("game auth exposes only Wiki bootstrap journal outcomes and never calls Cargo directly", async () => {
  const cases = [
    {
      state: "ready",
      status: 200,
      result: { status: "connected", serverManaged: true },
    },
    {
      state: "failed",
      reason: "invalid_game_session",
      status: 401,
      result: { error: "game_auth_rejected" },
    },
    {
      state: "auth_outcome_unknown",
      status: 409,
      result: { error: "game_auth_unknown" },
    },
    {
      state: "exchange_pending",
      status: 503,
      result: { error: "game_unavailable" },
    },
  ];
  for (const fixture of cases) {
    const wikiCalls = [];
    let cargoCalls = 0;
    const api = createConnectorApi({
      appParams: async () => ({}),
      wikiOrigins: ["https://wiki.example"],
      wikiFetcher: async (_url, options) => {
        const body = JSON.parse(options.body);
        wikiCalls.push(body);
        if (body.operation === "device.list")
          return Response.json({
            requestId: body.requestId,
            operation: body.operation,
            devices: [],
            routePolicy: null,
          });
        return Response.json({
          requestId: body.requestId,
          operation: body.operation,
          operationId: uuid(79),
          status: fixture.state,
          ...(fixture.reason ? { reason: fixture.reason } : {}),
        });
      },
      fetcher: async () => {
        cargoCalls++;
        return Response.json({
          accessToken: "must-not-be-issued-by-Connector",
        });
      },
    });
    const response = await api(
      new Request("https://connect.example/api/game-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          initData: gameInitData(),
          wikiInitData: signedWikiInitData(),
        }),
      }),
    );
    assert.equal(response.status, fixture.status);
    assert.deepEqual(await response.json(), fixture.result);
    assert.deepEqual(
      wikiCalls.map(({ operation }) => operation),
      ["device.list", "game_auth.bootstrap"],
    );
    assert.equal(cargoCalls, 0);
  }
});

test("Wiki auth bootstrap outage never invokes Cargo or Connector token storage", async () => {
  const wikiCalls = [];
  let accountSessionCalls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: ["https://wiki.example"],
    wikiFetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      wikiCalls.push(body);
      if (body.operation === "device.list")
        return Response.json({
          requestId: body.requestId,
          operation: body.operation,
          devices: [],
          routePolicy: null,
        });
      return Response.json({ error: "game_auth_unavailable" }, { status: 503 });
    },
    fetcher: async () =>
      assert.fail("Cargo authentication must remain on the Wiki"),
    accountSessions: async () => {
      accountSessionCalls += 1;
      assert.fail("game bootstrap must not access legacy Connector storage");
    },
  });
  const response = await api(
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initData: gameInitData(),
        wikiInitData: signedWikiInitData(),
      }),
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "game_auth_unavailable" });
  assert.deepEqual(
    wikiCalls.map(({ operation }) => operation),
    ["device.list", "game_auth.bootstrap"],
  );
  assert.equal(accountSessionCalls, 0);
});

test("restoring a QR session waiting for 2FA resumes password entry before game exchange", async () => {
  let needsPassword = true,
    launches = 0,
    exchanges = 0;
  const states = [];
  const conn = createConnection({
    createClient: () =>
      client({
        getMe: async () => {
          if (needsPassword) throw { text: "SESSION_PASSWORD_NEEDED" };
          return { id: 42 };
        },
        call: async (request) => {
          if (request._ === "account.getPassword")
            return { _: "account.password" };
          if (request._ === "auth.checkPassword")
            return { _: "auth.authorization", user: { id: 42 } };
          throw new Error("unexpected auth method");
        },
        computeSrpParams: async (_info, value) => {
          assert.equal(value, "private-test-password");
          return { _: "inputCheckPasswordSRP" };
        },
        notifyLoggedIn: async () => {
          needsPassword = false;
          return { id: 42 };
        },
        openWebview: async () => {
          launches++;
          return { url: launch };
        },
      }),
    exchange: async () => {
      exchanges++;
      return { serverManaged: true };
    },
    onState: ({ stage }) => states.push(stage),
  });
  assert.deepEqual(await conn.gameLogin("42"), { status: "password-required" });
  assert.equal(launches, 0);
  assert.equal(exchanges, 0);
  assert.equal(states.at(-1), "password");
  await conn.password("private-test-password");
  assert.deepEqual(await conn.gameLogin("42"), {
    status: "connected",
    serverManaged: true,
  });
  assert.equal(launches, 1);
  assert.equal(exchanges, 1);
});

test("2FA recovery still rejects the wrong account after password verification", async () => {
  let needsPassword = true;
  const conn = createConnection({
    createClient: () =>
      client({
        getMe: async () => {
          if (needsPassword) throw { text: "SESSION_PASSWORD_NEEDED" };
          return { id: 99 };
        },
        call: async (request) => {
          if (request._ === "account.getPassword")
            return { _: "account.password" };
          if (request._ === "auth.checkPassword")
            return { _: "auth.authorization", user: { id: 99 } };
          throw new Error("unexpected auth method");
        },
        computeSrpParams: async () => ({ _: "inputCheckPasswordSRP" }),
        notifyLoggedIn: async () => {
          needsPassword = false;
          return { id: 99 };
        },
      }),
    exchange: async () => {
      throw new Error("must not exchange for wrong account");
    },
  });
  assert.equal((await conn.gameLogin("42")).status, "password-required");
  await conn.password("private-test-password");
  assert.equal((await conn.gameLogin("42")).status, "login-required");
});
