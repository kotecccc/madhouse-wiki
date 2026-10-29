import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createSessionApi } from "../shared/session-api.js";
import {
  createAccountSessions,
  verifyWikiIdentity,
} from "../connector/account-session.js";
import {
  createWikiSessionAuthority,
  isWikiSessionCredential,
} from "../shared/wiki-session.js";
import {
  clearIdentityProof,
  readIdentityProof,
  saveIdentityProof,
} from "../connector/identity-proof-storage.js";
const verificationKey = "11".repeat(32),
  encryptionKey = "22".repeat(32),
  wikiSessionKey = "33".repeat(32);
const now = 1900000000000;
const signed = (id = 42, time = now, key = verificationKey) => {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(time / 1000)),
    user: JSON.stringify({ id }),
    signature: "signed-public-field",
  });
  const check = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  p.set(
    "hash",
    createHmac("sha256", Buffer.from(key, "hex")).update(check).digest("hex"),
  );
  return p.toString();
};
const jwt = () =>
  [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString(
      "base64url",
    ),
    "game-signature",
  ].join(".");
function setup({ profileStatuses = [], withOwnerLease } = {}) {
  const records = new Map();
  let serial = 0;
  let profileCalls = 0;
  let clock = now,
    gameId = 42,
    playerId = 2042,
    accepted = true;
  const store = {
    async read(key) {
      return records.get(key) || null;
    },
    async write(key, value, etag) {
      const old = records.get(key);
      if ((etag === null && old) || (etag !== null && old?.etag !== etag))
        throw new Error("cas_conflict");
      records.set(key, { value, etag: String(++serial) });
    },
  };
  const api = createAccountSessions({
    store,
    verificationKey,
    encryptionKey,
    wikiSessionKey,
    now: () => clock,
    pause: async () => {},
    withOwnerLease,
    fetcher: async (url, opts) => {
      profileCalls++;
      assert.equal(url, "https://cargohustle.online/api/me");
      assert.equal(opts.headers.Authorization, "Bearer " + jwt());
      assert.equal(opts.redirect, "error");
      return new Response(
        JSON.stringify({
          telegramId: gameId,
          playerId,
          privateProfile: "never-store-this",
        }),
        { status: profileStatuses.shift() ?? (accepted ? 200 : 401) },
      );
    },
  });
  const call = (action, extra = {}, id = 42) =>
    api({ action, wikiInitData: signed(id, clock), ...extra });
  const makeLegacy = async () => {
    const [path, stored] = [...records.entries()][0] || [];
    assert.ok(path && stored);
    const key = await webcrypto.subtle.importKey(
      "raw",
      Buffer.from(encryptionKey, "hex"),
      "AES-GCM",
      false,
      ["decrypt", "encrypt"],
    );
    const envelope = JSON.parse(stored.value);
    const plain = await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(envelope.iv, "base64url"),
        additionalData: new TextEncoder().encode(path),
      },
      key,
      Buffer.from(envelope.data, "base64url"),
    );
    const record = JSON.parse(new TextDecoder().decode(plain));
    delete record.playerId;
    delete record.telegramUserId;
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await webcrypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(path),
      },
      key,
      new TextEncoder().encode(JSON.stringify(record)),
    );
    records.set(path, {
      ...stored,
      value: JSON.stringify({
        v: 1,
        iv: Buffer.from(iv).toString("base64url"),
        data: Buffer.from(ciphertext).toString("base64url"),
      }),
    });
  };
  return {
    call,
    records,
    store,
    wikiSessions: createWikiSessionAuthority({
      store,
      encryptionKey,
      signingKey: wikiSessionKey,
      now: () => clock,
    }),
    api,
    setTime: (t) => (clock = t),
    setGameId: (id) => (gameId = id),
    setPlayerId: (id) => (playerId = id),
    makeLegacy,
    rejectGame: () => (accepted = false),
    profileCalls: () => profileCalls,
  };
}
test("signed Wiki identity rejects tampering, duplicate keys, wrong bot key and stale/future launches", async () => {
  assert.equal(await verifyWikiIdentity(signed(), verificationKey, now), "42");
  for (const data of [
    signed().replace("42", "99"),
    signed() + "&user=%7B%22id%22%3A99%7D",
    signed(42, now, "33".repeat(32)),
    signed(42, now - 301000),
    signed(42, now + 31000),
  ])
    await assert.rejects(
      verifyWikiIdentity(data, verificationKey, now),
      /invalid_wiki_identity/,
    );
});
test("same signed account restores across independent clients; another account never receives its JWT", async () => {
  const s = setup();
  const start = await s.call("restore");
  assert.equal(start.status, "login-required");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  assert.equal((await s.call("restore")).accessToken, jwt());
  const other = await s.call("restore", {}, 99);
  assert.equal(other.status, "login-required");
  assert.equal(other.accessToken, undefined);
  for (const [key, record] of s.records) {
    assert.doesNotMatch(key, /42|99/);
    assert.ok(!record.value.includes(jwt()));
    assert.ok(!record.value.includes("never-store-this"));
  }
});
test("Wiki credential is bound to the verified player and current revocable account revision", async () => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  const restored = await s.call("restore");
  assert.equal(restored.status, "connected");
  assert.equal(restored.gameConnection, "connected");
  assert.equal(restored.wikiSession.split(".").length, 3);
  const claims = JSON.parse(
    Buffer.from(restored.wikiSession.split(".")[1], "base64url").toString(),
  );
  assert.equal(claims.exp, Math.floor((now + 86400000) / 1000));
  assert.equal(
    (await s.wikiSessions.verify(restored.wikiSession)).playerId,
    2042,
  );
  s.setTime(now + 3600001);
  const expiredGame = await s.call("restore");
  assert.equal(expiredGame.status, "login-required");
  assert.equal(expiredGame.gameConnection, "login-required");
  assert.equal(
    (await s.wikiSessions.verify(expiredGame.wikiSession)).playerId,
    2042,
  );
  await s.call("logout");
  assert.equal(await s.wikiSessions.verify(expiredGame.wikiSession), null);
});

test("expired game session restores Wiki access through the runtime proxy without game traffic", async (t) => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  const directory = mkdtempSync(join(tmpdir(), "wiki-stored-route-"));
  let gameCalls = 0;
  const runtime = await createAutomationRuntime({
    env: {
      MADHOUSE_AUTOMATION_STATE_DIR: directory,
      MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
    },
    wikiSessionAuthority: s.wikiSessions,
    gameFetcher: async () => {
      gameCalls++;
      return Response.json({ playerId: 2042, nickname: "Saved" });
    },
  });
  t.after(() => {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.gameFetch("https://cargohustle.online/api/me", {
    headers: { Authorization: `Bearer ${jwt()}` },
  });
  assert.equal(gameCalls, 1);
  s.setTime(now + 3600001);
  const connectorCalls = s.profileCalls();
  const restored = await s.call("restore");
  assert.equal(restored.gameConnection, "login-required");
  assert.equal(s.profileCalls(), connectorCalls);
  assert.equal(isWikiSessionCredential(`Bearer ${restored.wikiSession}`), true);
  assert.equal(isWikiSessionCredential(`Bearer ${jwt()}`), false);
  const call = async (path, credential) => {
    const response = {
      setHeader() {},
      end(body) {
        this.body = body;
      },
    };
    await runtime.proxy(
      {
        method: "GET",
        url: path,
        headers: {
          authorization: `Bearer ${credential}`,
          "x-madhouse-stored-only": "1",
        },
      },
      response,
    );
    return response;
  };
  assert.equal((await call("/api/me", restored.wikiSession)).statusCode, 200);
  assert.equal(
    (await call("/api/rooms", restored.wikiSession)).statusCode,
    404,
  );
  const client = createSessionApi({
    authorize: ({ url }) => ({
      url,
      headers: { Authorization: `Bearer ${restored.wikiSession}` },
    }),
    interval: 0,
    fetcher: async (url, options) => {
      const headers = {};
      const response = {
        setHeader(key, value) {
          headers[key] = value;
        },
        end(body) {
          this.body = body;
        },
      };
      await runtime.proxy(
        {
          method: options.method,
          url,
          headers: Object.fromEntries(new Headers(options.headers)),
        },
        response,
      );
      return new Response(response.body, {
        status: response.statusCode,
        headers,
      });
    },
  });
  assert.equal((await client.readStored("/api/me")).data.playerId, 2042);
  assert.equal((await client.readStored("/api/rooms")).presence, "unknown");
  const denied = {
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  await runtime.proxy(
    {
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${restored.wikiSession}`,
        "x-madhouse-snapshot-refresh": "live",
      },
    },
    denied,
  );
  assert.equal(denied.statusCode, 401);
  assert.equal(gameCalls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gameCalls, 1);
  await s.call("logout");
  assert.notEqual(
    (await call("/api/me", restored.wikiSession)).statusCode,
    200,
  );
  assert.equal(gameCalls, 1);
});

test("legacy account restores saved data by verified owner and exact token without game traffic", async (t) => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  await s.makeLegacy();
  const directory = mkdtempSync(join(tmpdir(), "wiki-legacy-route-"));
  let gameCalls = 0;
  const runtime = await createAutomationRuntime({
    env: {
      MADHOUSE_AUTOMATION_STATE_DIR: directory,
      MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
    },
    wikiSessionAuthority: s.wikiSessions,
    gameFetcher: async () => {
      gameCalls++;
      return Response.json({ playerId: 2042, telegramId: 42 });
    },
  });
  t.after(() => {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await runtime.gameFetch("https://cargohustle.online/api/me", {
    headers: { Authorization: `Bearer ${jwt()}` },
  });
  s.setTime(now + 3600001);
  const restored = await s.call("restore");
  const response = {
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  await runtime.proxy(
    {
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${restored.wikiSession}`,
        "x-madhouse-stored-only": "1",
      },
    },
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).playerId, 2042);
  assert.equal(gameCalls, 1);
});

test("Wiki-only automation state and stop remain local while game actions are denied", async (t) => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  s.setTime(now + 3600001);
  const restored = await s.call("restore");
  const directory = mkdtempSync(join(tmpdir(), "wiki-automation-state-"));
  const store = createAutomationStateStore({ directory });
  store.write("2042", { credential: `Bearer ${jwt()}` });
  store.close();
  let gameCalls = 0;
  const runtime = await createAutomationRuntime({
    env: { MADHOUSE_AUTOMATION_STATE_DIR: directory },
    wikiSessionAuthority: s.wikiSessions,
    gameFetcher: async () => {
      gameCalls++;
      throw Error("game unavailable");
    },
  });
  t.after(() => {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const authorization = `Bearer ${restored.wikiSession}`;
  const before = gameCalls;
  const state = await runtime.handle(
    new Request("http://wiki.test/api/automation/state", {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(state.status, 200);
  const saved = await state.json();
  const command = await runtime.handle(
    new Request("http://wiki.test/api/automation/commands", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "stop-wiki-session",
        command: "auto.stop",
        expectedVersion: saved.version,
      }),
    }),
  );
  assert.equal(command.status, 200);
  const forbidden = await runtime.handle(
    new Request("http://wiki.test/api/automation/commands", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "start-wiki-session",
        command: "auto.start",
        expectedVersion: saved.version,
      }),
    }),
  );
  assert.equal(forbidden.status, 401);
  assert.equal(gameCalls, before);
});
test("Wiki credential rejects tampering, expiry, and an unverified game playerId", async () => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  const credential = (await s.call("restore")).wikiSession;
  assert.equal(await s.wikiSessions.verify(credential + "x"), null);
  s.setTime(now + 86400001);
  assert.equal(await s.wikiSessions.verify(credential), null);

  const badProfile = setup();
  badProfile.setPlayerId(0);
  const pending = await badProfile.call("restore");
  await assert.rejects(
    badProfile.call("save", { ticket: pending.ticket, accessToken: jwt() }),
    /game_account_mismatch/,
  );
  assert.equal((await badProfile.call("restore")).wikiSession, undefined);
});
test("legacy verified account record resolves internally without exposing or refreshing its expired game token", async () => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  await s.makeLegacy();
  s.setTime(now + 3600001);
  const restored = await s.call("restore");
  assert.equal(restored.status, "login-required");
  assert.equal(restored.accessToken, undefined);
  assert.equal(typeof restored.wikiSession, "string");
  const internal = await s.wikiSessions.verify(restored.wikiSession);
  assert.deepEqual(internal, {
    legacyAuthorization: `Bearer ${jwt()}`,
    telegramUserId: "42",
    expiresAt: Math.floor((now + 3600001 + 86400000) / 1000) * 1000,
  });
  assert.equal(
    Buffer.from(restored.wikiSession.split(".")[1], "base64url")
      .toString()
      .includes(jwt()),
    false,
  );
  const other = await s.call("restore", {}, 99);
  assert.equal(other.wikiSession, undefined);
  await s.call("logout");
  assert.equal(await s.wikiSessions.verify(restored.wikiSession), null);
});
test("server requires actual game authentication and its Telegram account identity, not decoded JWT claims", async () => {
  const s = setup();
  const start = await s.call("restore");
  s.setGameId(99);
  await assert.rejects(
    s.call("save", { ticket: start.ticket, accessToken: jwt() }),
    /game_account_mismatch/,
  );
  s.setGameId(42);
  s.rejectGame();
  await assert.rejects(
    s.call("save", { ticket: start.ticket, accessToken: jwt() }),
    /invalid_game_session/,
  );
  assert.equal((await s.call("restore")).accessToken, undefined);
});
test("expiry does not extend game JWT and logout invalidates an earlier save ticket", async () => {
  const s = setup();
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  s.setTime(now + 3600001);
  assert.equal((await s.call("restore")).status, "login-required");
  s.setTime(now);
  const pending = await s.call("restore", {}, 99);
  await s.call("logout", {}, 99);
  await assert.rejects(
    s.call("save", { ticket: pending.ticket, accessToken: jwt() }, 99),
    /session_changed/,
  );
  await s.call("logout");
  assert.equal((await s.call("restore")).revoked, true);
  assert.equal((await s.call("restore")).accessToken, undefined);
});
test("CAS prevents a save already in flight resurrecting a logged-out server session", async () => {
  const s = setup();
  const start = await s.call("restore");
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const original = s.store.write;
  s.store.write = async (...args) => {
    if (args[1].includes('"v":1') && release === undefined) {
      await new Promise((r) => {
        release = r;
        entered();
      });
    }
    return original(...args);
  };
  const pending = s.call("save", { ticket: start.ticket, accessToken: jwt() });
  const rejected = assert.rejects(pending, /cas_conflict/);
  await ready;
  // Bypass this test's delayed write for logout, preserving its actual CAS.
  s.store.write = original;
  await s.call("logout");
  release();
  await rejected;
  assert.equal((await s.call("restore")).revoked, true);
});

test("short launch bootstrap exchanges for a bounded encrypted connector proof, with no raw initData persistence", async () => {
  const s = setup();
  const initial = await s.call("restore");
  s.setTime(now + 600000);
  await assert.rejects(
    s.api({ action: "restore", wikiInitData: signed() }),
    /invalid_wiki_identity/,
  );
  assert.equal(
    (await s.api({ action: "restore", wikiProof: initial.wikiProof })).status,
    "login-required",
  );
  await assert.rejects(
    s.api({
      action: "restore",
      wikiProof: initial.wikiProof.slice(0, -4) + "bad",
    }),
    /invalid_wiki_identity/,
  );
  s.setTime(now + 86400001);
  await assert.rejects(
    s.api({ action: "restore", wikiProof: initial.wikiProof }),
    /invalid_wiki_identity/,
  );
});

test("a reload restores with the saved proof for the same launch only", async () => {
  const s = setup();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const launch = signed();
  const start = await s.api({ action: "restore", wikiInitData: launch });
  await s.api({
    action: "save",
    wikiProof: start.wikiProof,
    ticket: start.ticket,
    accessToken: jwt(),
  });
  await saveIdentityProof(storage, launch, start.wikiProof);
  assert.equal(
    [...values.values()].some((value) => value.includes(launch)),
    false,
  );
  s.setTime(now + 600000);
  const proof = await readIdentityProof(storage, launch);
  assert.equal(
    (await s.api({ action: "restore", wikiProof: proof })).accessToken,
    jwt(),
  );
  assert.equal(await readIdentityProof(storage, signed(99)), null);
  await s.api({ action: "logout", wikiProof: proof });
  clearIdentityProof(storage);
  assert.equal(await readIdentityProof(storage, launch), null);
  assert.equal(
    (await s.api({ action: "restore", wikiProof: proof })).revoked,
    true,
  );
});

test("temporary profile verification failure recovers without weakening account matching", async () => {
  const s = setup({ profileStatuses: [500, 200] });
  const start = await s.call("restore");
  await s.call("save", { ticket: start.ticket, accessToken: jwt() });
  assert.equal(s.profileCalls(), 2);
  assert.equal((await s.call("restore")).accessToken, jwt());

  const wrong = setup({ profileStatuses: [500, 200] });
  const pending = await wrong.call("restore");
  wrong.setGameId(99);
  await assert.rejects(
    wrong.call("save", { ticket: pending.ticket, accessToken: jwt() }),
    /game_account_mismatch/,
  );
  assert.equal(wrong.profileCalls(), 2);
  assert.equal((await wrong.call("restore")).status, "login-required");
});

test("profile verification retries are bounded and never retry rejected credentials", async () => {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    const s = setup({ profileStatuses: [status, status, status] });
    const start = await s.call("restore");
    await assert.rejects(
      s.call("save", { ticket: start.ticket, accessToken: jwt() }),
      status >= 500 || status === 429
        ? /game_unavailable/
        : /invalid_game_session/,
    );
    assert.equal(s.profileCalls(), status >= 500 ? 3 : 1);
    assert.equal((await s.call("restore")).status, "login-required");
  }
});

test("bridge guard blocks direct profile verification for a bridge owner", async () => {
  const s = setup({
    withOwnerLease: async (_owner, _operation, _run) => {
      throw Object.assign(new Error("blocked"), {
        code: "bridge_route_required",
      });
    },
  });
  const start = await s.call("restore");
  await assert.rejects(
    s.call("save", { ticket: start.ticket, accessToken: jwt() }),
    { message: "bridge_route_required" },
  );
  assert.equal(s.profileCalls(), 0);
});
