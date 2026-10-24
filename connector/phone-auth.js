const authCallOptions = Object.freeze({
  floodSleepThreshold: 0,
  maxRetryCount: 0,
});

const knownRpcErrors = new Set([
  "API_ID_INVALID",
  "API_ID_PUBLISHED_FLOOD",
  "AUTH_FAILED",
  "AUTH_RESTART",
  "PASSWORD_HASH_INVALID",
  "PAYMENT_REQUIRED",
  "PHONE_CODE_EMPTY",
  "PHONE_CODE_EXPIRED",
  "PHONE_CODE_FLOOD",
  "PHONE_CODE_INVALID",
  "PHONE_NUMBER_APP_SIGNUP_FORBIDDEN",
  "PHONE_NUMBER_BANNED",
  "PHONE_NUMBER_FLOOD",
  "PHONE_NUMBER_INVALID",
  "PHONE_NUMBER_OCCUPIED",
  "PHONE_NUMBER_UNOCCUPIED",
  "RESEND_UNAVAILABLE",
  "RESEND_WAIT",
  "SESSION_PASSWORD_NEEDED",
  "SMS_CODE_CREATE_FAILED",
  "SRP_ID_INVALID",
]);

const deliveryTypes = {
  "auth.sentCodeTypeApp": "app",
  "auth.sentCodeTypeCall": "call",
  "auth.sentCodeTypeEmailCode": "email",
  "auth.sentCodeTypeFirebaseSms": "firebase",
  "auth.sentCodeTypeFlashCall": "flash_call",
  "auth.sentCodeTypeFragmentSms": "fragment",
  "auth.sentCodeTypeMissedCall": "missed_call",
  "auth.sentCodeTypeSetUpEmailRequired": "email_required",
  "auth.sentCodeTypeSms": "sms",
  "auth.sentCodeTypeSmsPhrase": "sms_phrase",
  "auth.sentCodeTypeSmsWord": "sms_word",
};

const nextDeliveryTypes = {
  "auth.codeTypeCall": "call",
  "auth.codeTypeFlashCall": "flash_call",
  "auth.codeTypeFragmentSms": "fragment",
  "auth.codeTypeMissedCall": "missed_call",
  "auth.codeTypeSms": "sms",
};

const MAX_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;

function safeSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, MAX_TIMEOUT_SECONDS);
}

function safeError(text, extra = {}) {
  const error = new Error(text);
  error.name = "PhoneAuthError";
  error.text = text;
  if (Number.isSafeInteger(extra.waitSeconds) && extra.waitSeconds >= 0)
    error.waitSeconds = safeSeconds(extra.waitSeconds);
  return error;
}

export function sanitizePhoneAuthError(error) {
  if (error?.name === "AbortError" || error?.message === "cancelled")
    return error;

  const rawText = typeof error?.text === "string" ? error.text : "";
  const floodWaitMatch = rawText.match(/^FLOOD_WAIT_(\d+)$/);
  const waitSeconds = Number.isSafeInteger(error?.waitSeconds)
    ? error.waitSeconds
    : Number.isSafeInteger(error?.seconds)
      ? error.seconds
      : floodWaitMatch
        ? Number(floodWaitMatch[1])
        : null;
  if (rawText === "FLOOD_WAIT_%d" || rawText === "FLOOD_WAIT" || floodWaitMatch)
    return safeError("FLOOD_WAIT", {
      waitSeconds: waitSeconds == null ? 0 : waitSeconds,
    });

  if (knownRpcErrors.has(rawText))
    return safeError(rawText, { waitSeconds: error?.waitSeconds });
  return safeError("AUTH_FAILED");
}

export function normalizePhoneNumber(value) {
  const phone = String(value || "")
    .trim()
    .replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw safeError("PHONE_NUMBER_INVALID");
  return phone;
}

async function authCall(client, request, abortSignal) {
  try {
    return await client.call(request, {
      ...authCallOptions,
      ...(abortSignal ? { abortSignal } : {}),
    });
  } catch (error) {
    throw sanitizePhoneAuthError(error);
  }
}

function challengeFrom(response, now = Date.now) {
  if (
    response?._ !== "auth.sentCode" ||
    typeof response.phoneCodeHash !== "string" ||
    response.phoneCodeHash.length === 0 ||
    response.phoneCodeHash.length > 1024 ||
    !response.type ||
    typeof response.type._ !== "string"
  )
    throw safeError("AUTH_FAILED");

  const timeout = safeSeconds(response.timeout);
  const rawLength = response.type.length;
  const length =
    Number.isSafeInteger(rawLength) && rawLength > 0
      ? Math.min(rawLength, 64)
      : 0;
  return {
    phoneCodeHash: response.phoneCodeHash,
    type: deliveryTypes[response.type._] || "unknown",
    nextType: nextDeliveryTypes[response.nextType?._] || "none",
    timeout,
    resendAt: now() + timeout * 1000,
    length,
  };
}

async function authorized(client, authorization) {
  try {
    await client.notifyLoggedIn(authorization);
    return { status: "authorized" };
  } catch (error) {
    throw sanitizePhoneAuthError(error);
  }
}

async function sentCodeResult(client, response, now) {
  if (response?._ === "auth.sentCodeSuccess")
    return authorized(client, response.authorization);
  if (response?._ === "auth.sentCodePaymentRequired")
    throw safeError("PAYMENT_REQUIRED");
  return { status: "challenge", challenge: challengeFrom(response, now) };
}

export async function requestPhoneCode(
  client,
  phoneValue,
  { abortSignal, now = Date.now } = {},
) {
  const phone = normalizePhoneNumber(phoneValue);
  try {
    const { id, hash } = await client.getApiCredentials();
    const response = await authCall(
      client,
      {
        _: "auth.sendCode",
        phoneNumber: phone,
        apiId: id,
        apiHash: hash,
        settings: { _: "codeSettings" },
      },
      abortSignal,
    );
    return await sentCodeResult(client, response, now);
  } catch (error) {
    throw sanitizePhoneAuthError(error);
  }
}

export function canResendPhoneCode(challenge, now = Date.now()) {
  return (
    !!challenge &&
    challenge.nextType !== "none" &&
    Number.isFinite(challenge.resendAt) &&
    now >= challenge.resendAt
  );
}

export async function resendPhoneCode(
  client,
  phoneValue,
  challenge,
  { abortSignal, now = Date.now } = {},
) {
  const phone = normalizePhoneNumber(phoneValue);
  if (!challenge || typeof challenge.phoneCodeHash !== "string")
    throw safeError("RESEND_UNAVAILABLE");
  if (challenge.nextType === "none") throw safeError("RESEND_UNAVAILABLE");
  if (!canResendPhoneCode(challenge, now()))
    throw safeError("RESEND_WAIT", {
      waitSeconds: Math.max(0, Math.ceil((challenge.resendAt - now()) / 1000)),
    });

  const response = await authCall(
    client,
    {
      _: "auth.resendCode",
      phoneNumber: phone,
      phoneCodeHash: challenge.phoneCodeHash,
    },
    abortSignal,
  );
  return sentCodeResult(client, response, now);
}

export async function submitPhoneCode(
  client,
  phoneValue,
  challenge,
  phoneCode,
  { abortSignal } = {},
) {
  const phone = normalizePhoneNumber(phoneValue);
  if (!challenge || typeof challenge.phoneCodeHash !== "string")
    throw safeError("PHONE_CODE_EXPIRED");
  const response = await authCall(
    client,
    {
      _: "auth.signIn",
      phoneNumber: phone,
      phoneCodeHash: challenge.phoneCodeHash,
      phoneCode: String(phoneCode),
    },
    abortSignal,
  );
  if (response?._ === "auth.authorizationSignUpRequired")
    throw safeError("PHONE_NUMBER_UNOCCUPIED");
  if (response?._ !== "auth.authorization") throw safeError("AUTH_FAILED");
  return authorized(client, response);
}

export async function submitPhonePassword(
  client,
  password,
  { abortSignal } = {},
) {
  try {
    const passwordInfo = await authCall(
      client,
      { _: "account.getPassword" },
      abortSignal,
    );
    const srpPassword = await client.computeSrpParams(passwordInfo, password);
    const response = await authCall(
      client,
      { _: "auth.checkPassword", password: srpPassword },
      abortSignal,
    );
    if (response?._ !== "auth.authorization") throw safeError("AUTH_FAILED");
    return await authorized(client, response);
  } catch (error) {
    throw sanitizePhoneAuthError(error);
  }
}
