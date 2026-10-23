import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  authErrorCategory,
  validateAuthTrace,
} from "../connector/auth-trace.js";
import { createConnection } from "../connector/session.js";
import { createAccountSessions } from "../connector/account-session.js";

const id = "00000000-0000-4000-8000-000000000001";
const event = { id, sequence: 1, event: "send-start", memoryOnly: false };

test("auth telemetry rejects secrets, arbitrary strings, and unbounded values", () => {
  assert.deepEqual(validateAuthTrace(event), event);
  for (const extra of [
    { phone: "+10000000000" },
    { phoneCodeHash: "secret" },
    { code: "12345" },
    { session: "secret" },
    { userId: "42" },
    { errorCategory: "secret message" },
    { deliveryType: "secret" },
    { sequence: 65 },
    { elapsedMs: Infinity },
    { id: "+10000000000" },
    { event: "secret" },
    { memoryOnly: "secret" },
  ])
    assert.throws(
      () => validateAuthTrace({ ...event, ...extra }),
      /invalid_request/,
    );
  assert.equal(authErrorCategory({ text: "FLOOD_WAIT_170" }), "FLOOD_WAIT");
  assert.equal(
    authErrorCategory({ text: "arbitrary request payload" }),
    "UNKNOWN",
  );
});

test("actual SDK calls emit ordered safe events while challenge retains its hash", async () => {
  const events = [];
  let calls = 0;
  const connection = createConnection({
    createClient: () => ({
      sendCode: async () => {
        calls++;
        return {
          phoneCodeHash: "secret-hash",
          type: "app",
          length: 5,
          nextType: "none",
          timeout: 0,
          raw: { phone: "private" },
        };
      },
    }),
    onAuthEvent: (value) => events.push(value),
    now: () => 100,
  });
  const challenge = await connection.phoneCode("private-phone");
  assert.equal(calls, 1);
  assert.equal(challenge.phoneCodeHash, "secret-hash");
  assert.deepEqual(events, [
    { event: "send-start", memoryOnly: false },
    {
      event: "send-response",
      deliveryType: "app",
      nextDeliveryType: "none",
      codeLength: 5,
      timeout: 0,
      elapsedMs: 0,
      memoryOnly: false,
    },
  ]);
  for (const [index, value] of events.entries())
    validateAuthTrace({ id, sequence: index + 1, ...value });
  assert.doesNotMatch(JSON.stringify(events), /secret|private|phoneCodeHash/);
});

test("SDK error telemetry contains an enum while original error reaches the UI", async () => {
  const events = [];
  const error = { text: "PHONE_NUMBER_FLOOD", request: { phone: "private" } };
  const connection = createConnection({
    createClient: () => ({
      sendCode: async () => {
        throw error;
      },
    }),
    onAuthEvent: (value) => events.push(value),
  });
  await assert.rejects(
    connection.phoneCode("private"),
    (value) => value === error,
  );
  assert.deepEqual(events[1], {
    event: "send-error",
    errorCategory: "PHONE_NUMBER_FLOOD",
    memoryOnly: false,
  });
  assert.doesNotMatch(JSON.stringify(events), /private|request/);
});

test("diagnostic endpoint verifies identity and never accesses account/game storage", async () => {
  const key = "11".repeat(32);
  const now = 1900000000000;
  const params = new URLSearchParams({
    auth_date: String(now / 1000),
    user: JSON.stringify({ id: 42 }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  params.set(
    "hash",
    createHmac("sha256", Buffer.from(key, "hex")).update(check).digest("hex"),
  );
  const logged = [];
  const api = createAccountSessions({
    verificationKey: key,
    encryptionKey: "22".repeat(32),
    now: () => now,
    store: {
      read: () => assert.fail("must not read account storage"),
      write: () => assert.fail("must not write account storage"),
    },
    fetcher: () => assert.fail("must not call game API"),
    onAuthDiagnostic: (value) => logged.push(value),
  });
  const request = {
    action: "diagnostic",
    wikiInitData: params.toString(),
    diagnostic: event,
  };
  assert.equal((await api(request)).status, "accepted");
  assert.deepEqual(logged, [event]);
  await assert.rejects(
    api({ ...request, wikiInitData: "invalid" }),
    /invalid_wiki_identity/,
  );
  await assert.rejects(
    api({ ...request, diagnostic: { ...event, phone: "private" } }),
    /invalid_request/,
  );
  assert.equal(logged.length, 1);
});
