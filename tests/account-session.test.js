import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createAccountSessions,
  verifyWikiIdentity,
} from "../connector/account-session.js";
const verificationKey = "11".repeat(32),
  encryptionKey = "22".repeat(32);
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
          privateProfile: "never-store-this",
        }),
        { status: profileStatuses.shift() ?? (accepted ? 200 : 401) },
      );
    },
  });
  const call = (action, extra = {}, id = 42) =>
    api({ action, wikiInitData: signed(id, clock), ...extra });
  return {
    call,
    records,
    store,
    api,
    setTime: (t) => (clock = t),
    setGameId: (id) => (gameId = id),
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
