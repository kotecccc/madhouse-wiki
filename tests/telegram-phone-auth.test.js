import test from "node:test";
import assert from "node:assert/strict";
import {
  canResendPhoneCode,
  normalizePhoneNumber,
  requestPhoneCode,
  resendPhoneCode,
  sanitizePhoneAuthError,
  submitPhoneCode,
  submitPhonePassword,
} from "../connector/phone-auth.js";

const phone = "+12025550123";
const authOptions = { floodSleepThreshold: 0, maxRetryCount: 0 };

function fakeClient(call, extra = {}) {
  return {
    getApiCredentials: async () => ({ id: 42, hash: "test-api-hash" }),
    call,
    notifyLoggedIn: async () => ({ id: 42 }),
    computeSrpParams: async () => ({ _: "inputCheckPasswordSRP" }),
    ...extra,
  };
}

test("phone normalization accepts international input and rejects unsafe values", () => {
  assert.equal(normalizePhoneNumber(" +1 (202) 555-0123 "), phone);
  assert.throws(() => normalizePhoneNumber("202-555-0123"), {
    text: "PHONE_NUMBER_INVALID",
  });
});

test("sendCode returns only the delivery fields and disables flood waiting and retries", async () => {
  const calls = [];
  const client = fakeClient(async (request, options) => {
    calls.push({ request, options });
    return {
      _: "auth.sentCode",
      phoneCodeHash: "opaque-hash",
      phonePattern: "+1***",
      timeout: 40,
      nextType: { _: "auth.codeTypeSms" },
      type: {
        _: "auth.sentCodeTypeSms",
        length: 6,
        extraPrivateField: "must-not-escape",
      },
    };
  });

  const result = await requestPhoneCode(client, phone, { now: () => 1000 });

  assert.deepEqual(result, {
    status: "challenge",
    challenge: {
      phoneCodeHash: "opaque-hash",
      type: "sms",
      nextType: "sms",
      timeout: 40,
      resendAt: 41000,
      length: 6,
    },
  });
  assert.deepEqual(calls, [
    {
      request: {
        _: "auth.sendCode",
        phoneNumber: phone,
        apiId: 42,
        apiHash: "test-api-hash",
        settings: { _: "codeSettings" },
      },
      options: authOptions,
    },
  ]);
  assert.equal(JSON.stringify(result).includes("must-not-escape"), false);
  assert.equal(JSON.stringify(result).includes("phonePattern"), false);
});

test("resend requires Telegram's nextType and timeout, then makes one explicit request", async () => {
  let calls = 0;
  const client = fakeClient(async (request, options) => {
    calls++;
    assert.deepEqual(request, {
      _: "auth.resendCode",
      phoneNumber: phone,
      phoneCodeHash: "old-hash",
    });
    assert.deepEqual(options, authOptions);
    return {
      _: "auth.sentCode",
      phoneCodeHash: "new-hash",
      timeout: 0,
      nextType: { _: "auth.codeTypeCall" },
      type: { _: "auth.sentCodeTypeSms", length: 5 },
    };
  });
  const challenge = {
    phoneCodeHash: "old-hash",
    type: "sms",
    nextType: "sms",
    timeout: 30,
    resendAt: 5000,
    length: 5,
  };

  assert.equal(canResendPhoneCode(challenge, 4999), false);
  await assert.rejects(
    resendPhoneCode(client, phone, challenge, { now: () => 4000 }),
    (error) => error.text === "RESEND_WAIT" && error.waitSeconds === 1,
  );
  assert.equal(calls, 0);

  const result = await resendPhoneCode(client, phone, challenge, {
    now: () => 5000,
  });
  assert.equal(result.status, "challenge");
  assert.equal(result.challenge.phoneCodeHash, "new-hash");
  assert.equal(result.challenge.nextType, "call");
  assert.equal(calls, 1);
});

test("FLOOD_WAIT is returned with seconds and never retried or logged with raw text", async () => {
  let calls = 0;
  const source = new Error("private phone and request details");
  source.text = "FLOOD_WAIT_%d";
  source.seconds = 91;
  const client = fakeClient(async () => {
    calls++;
    throw source;
  });

  await assert.rejects(requestPhoneCode(client, phone), (error) => {
    assert.equal(error.text, "FLOOD_WAIT");
    assert.equal(error.waitSeconds, 91);
    assert.equal(error.message, "FLOOD_WAIT");
    assert.equal(error.stack.includes("private phone"), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("code sign-in and SRP password verification use one RPC each with no retry", async () => {
  const calls = [];
  const authorized = { _: "auth.authorization", user: { id: 42 } };
  let loggedIn = 0;
  const client = fakeClient(
    async (request, options) => {
      calls.push({ request, options });
      if (request._ === "auth.signIn") return authorized;
      if (request._ === "account.getPassword")
        return { _: "account.password", hint: "private server value" };
      if (request._ === "auth.checkPassword") return authorized;
      throw new Error("unexpected request");
    },
    {
      notifyLoggedIn: async (value) => {
        assert.deepEqual(value, authorized);
        loggedIn++;
        return { id: 42 };
      },
    },
  );
  const challenge = { phoneCodeHash: "hash" };

  assert.deepEqual(await submitPhoneCode(client, phone, challenge, "123456"), {
    status: "authorized",
  });
  assert.deepEqual(await submitPhonePassword(client, "test-password"), {
    status: "authorized",
  });
  assert.equal(loggedIn, 2);
  assert.deepEqual(
    calls.map(({ request, options }) => ({ method: request._, options })),
    [
      { method: "auth.signIn", options: authOptions },
      { method: "account.getPassword", options: authOptions },
      { method: "auth.checkPassword", options: authOptions },
    ],
  );
});

test("unknown Telegram errors are replaced with a fixed safe failure", () => {
  const error = sanitizePhoneAuthError({
    text: "PRIVATE_PHONE_RESPONSE",
    message: "private value",
  });
  assert.equal(error.text, "AUTH_FAILED");
  assert.equal(error.message, "AUTH_FAILED");
  assert.equal(error.stack.includes("private value"), false);
});
