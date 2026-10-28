import { connectionFailure } from "./diagnostics.js";
import { normalizeActiveBossBattle } from "../shared/active-boss-battle.js";
import {
  normalizePhoneNumber,
  requestPhoneCode,
  resendPhoneCode as requestPhoneResend,
  sanitizePhoneAuthError,
  submitPhoneCode,
  submitPhonePassword,
} from "./phone-auth.js";

export function createConnection({
  createClient,
  createMemoryClient,
  errorTypes,
  exchange,
  onState = () => {},
  storage = "madhouse-wiki-telegram-v1",
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let client,
    clientPromise,
    generation = 0,
    active = null,
    account = null,
    qrExpires = 0,
    cleanup = null;
  let memoryOnly = false,
    storageIdentity = null;
  let passwordRequired = false;
  let phoneAttempt = null;
  const authOperations = new Set();
  const state = (value) => onState(value);
  const localPhoneError = (text, waitSeconds) => {
    const error = new Error(text);
    error.text = text;
    if (Number.isSafeInteger(waitSeconds)) error.waitSeconds = waitSeconds;
    return sanitizePhoneAuthError(error);
  };
  async function getClient() {
    if (!client) {
      clientPromise ??= Promise.resolve().then(() =>
        (memoryOnly ? createMemoryClient : createClient)(
          storage + (storageIdentity ? "-" + storageIdentity : ""),
        ),
      );
      client = await clientPromise;
    }
    return client;
  }
  async function restore(expectedUserId) {
    const started = generation;
    if (cleanup) await cleanup;
    if (expectedUserId && storageIdentity !== expectedUserId) {
      if (client) await client.destroy();
      client = null;
      clientPromise = null;
      storageIdentity = expectedUserId;
      passwordRequired = false;
      phoneAttempt = null;
    }
    let stage = "CLIENT";
    try {
      const current = await getClient();
      stage = "RESTORE";
      const self = await current.getMe();
      if (started !== generation) throw new Error("cancelled");
      passwordRequired = false;
      if (expectedUserId && String(self.id) !== expectedUserId) {
        state({ stage: "wrong-account" });
        return false;
      }
      account = String(self.id);
      qrExpires = 0;
      state({ stage: "connected" });
      return true;
    } catch (error) {
      if (started !== generation || error?.message === "cancelled") {
        // eslint-disable-next-line preserve-caught-error
        throw new Error("cancelled");
      }
      if (error?.text === "SESSION_PASSWORD_NEEDED") {
        account = null;
        passwordRequired = true;
        state({ stage: "password" });
        return false;
      }
      if (
        [
          "AUTH_KEY_UNREGISTERED",
          "SESSION_REVOKED",
          "SESSION_EXPIRED",
          "USER_DEACTIVATED",
        ].includes(error?.text)
      ) {
        account = null;
        passwordRequired = false;
        state({ stage: "consent" });
        return false;
      }
      if (
        !memoryOnly &&
        createMemoryClient &&
        ([
          "InvalidStateError",
          "SecurityError",
          "QuotaExceededError",
          "NotSupportedError",
        ].includes(error?.name) ||
          (typeof errorTypes?.MtUnsupportedError === "function" &&
            error instanceof errorTypes.MtUnsupportedError))
      ) {
        // WKWebView can deny third-party IndexedDB. Retry once in memory; never
        // erase a user's existing persistent Telegram key on a storage failure.
        try {
          await client?.destroy();
        } catch {
          /* unusable storage */
        }
        client = null;
        clientPromise = null;
        memoryOnly = true;
        account = null;
        return restore(expectedUserId);
      }
      // Raw Telegram errors may contain request information; do not retain them.
      throw connectionFailure(error, stage, errorTypes);
    }
  }
  async function gameLogin(expectedUserId) {
    const identity = expectedUserId || null;
    if (active?.identity === identity) return active.promise;
    if (active) cancel();
    const started = generation;
    const task = (async () => {
      if (!(await restore(expectedUserId)))
        return {
          status: passwordRequired ? "password-required" : "login-required",
        };
      if (started !== generation) throw new Error("cancelled");
      const submitted = new Set();
      let exchanged;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await pause(1100 * attempt);
        if (started !== generation) throw new Error("cancelled");
        const launch = await client.openWebview({
          bot: "imadhouse_bot",
          platform: "web",
          webview: { type: "main" },
        });
        if (started !== generation) throw new Error("cancelled");
        const url = new URL(launch.url);
        if (url.origin !== "https://cargohustle.online")
          throw new Error("invalid_launch");
        const initData = new URLSearchParams(url.hash.slice(1)).get(
          "tgWebAppData",
        );
        if (!initData) throw new Error("invalid_launch");
        // A temporary game outage may be retried with a new signed launch.
        // Never replay a submitted launch, including one Telegram returned again.
        if (submitted.has(initData)) {
          if (attempt === 2) throw new Error("game_unavailable");
          continue;
        }
        submitted.add(initData);
        try {
          exchanged = await exchange(
            initData,
            client,
            () => started === generation,
          );
          break;
        } catch (error) {
          if (error?.message !== "game_unavailable" || attempt === 2)
            throw error;
        }
      }
      const accessToken =
        typeof exchanged === "string" ? exchanged : exchanged?.accessToken;
      const playerLevel =
        Number.isSafeInteger(exchanged?.playerLevel) &&
        exchanged.playerLevel > 0
          ? exchanged.playerLevel
          : null;
      const currentExp =
        Number.isSafeInteger(exchanged?.currentExp) && exchanged.currentExp >= 0
          ? exchanged.currentExp
          : null;
      const expToNextLevel =
        Number.isSafeInteger(exchanged?.expToNextLevel) &&
        exchanged.expToNextLevel > 0
          ? exchanged.expToNextLevel
          : null;
      const activeBossBattle = normalizeActiveBossBattle(
        exchanged?.activeBossBattle,
      );
      if (started !== generation) throw new Error("cancelled");
      return {
        status: "connected",
        accessToken,
        ...(playerLevel == null ? {} : { playerLevel }),
        ...(currentExp == null || expToNextLevel == null
          ? {}
          : { currentExp, expToNextLevel }),
        ...(activeBossBattle ? { activeBossBattle } : {}),
      };
    })();
    const entry = { promise: task, identity };
    active = entry;
    try {
      return await task;
    } finally {
      if (active === entry) active = null;
    }
  }
  function cancel() {
    generation++;
    active = null;
  }
  async function runAuth(operation, abortSignal) {
    const started = generation;
    if (cleanup) await cleanup;
    const current = await getClient();
    if (started !== generation) throw new Error("cancelled");
    const task = Promise.resolve().then(() => operation(current, abortSignal));
    authOperations.add(task);
    let result, failure;
    try {
      result = await task;
      if (result?._ === "auth.loginToken" && Number.isFinite(result.expires))
        qrExpires = result.expires * 1000 + 3000;
    } catch (error) {
      failure = error;
    } finally {
      authOperations.delete(task);
    }
    if (started !== generation) {
      await logout();
      throw new Error("cancelled");
    }
    if (failure) throw failure;
    return result;
  }
  async function logout() {
    if (cleanup) return cleanup;
    cancel();
    account = null;
    passwordRequired = false;
    phoneAttempt = null;
    cleanup = revoke();
    try {
      return await cleanup;
    } finally {
      cleanup = null;
    }
  }
  async function revoke() {
    let remoteRevoked = false,
      localCleared = false;
    try {
      const current = await getClient();
      // Let an already submitted code/password finish before revoking its key.
      await Promise.allSettled([...authOperations]);
      // An unapproved QR can still be approved until it expires. Keep its key
      // long enough to revoke a late grant instead of orphaning a new session.
      const monitorUntil = Math.min(qrExpires, now() + 120000);
      while (now() < monitorUntil) {
        try {
          await current.getMe();
          break;
        } catch (error) {
          if (error?.text !== "AUTH_KEY_UNREGISTERED") throw error;
        }
        await pause(Math.min(1000, qrExpires - now()));
      }
      await current.logOut();
      remoteRevoked = true;
    } catch (error) {
      if (error?.text === "AUTH_KEY_UNREGISTERED")
        remoteRevoked = now() >= qrExpires;
    } finally {
      if (client) {
        // Clear the browser key even when the server cannot confirm revocation.
        try {
          await client.notifyLoggedOut();
          localCleared = true;
        } catch {
          /* Report unconfirmed storage cleanup. */
        }
        try {
          await client.destroy();
        } catch {
          /* Closing a socket is not proof of key removal. */
        }
        client = null;
        clientPromise = null;
      }
      qrExpires = 0;
      state({ stage: "consent" });
    }
    return { status: "disconnected", remoteRevoked, localCleared };
  }
  async function phoneCode(phone, abortSignal) {
    const normalizedPhone = normalizePhoneNumber(phone);
    phoneAttempt = {
      phone: normalizedPhone,
      identity: storageIdentity,
      challenge: null,
    };
    state({ stage: "busy" });
    let result;
    try {
      result = await runAuth(
        (current, signal) =>
          requestPhoneCode(current, normalizedPhone, { abortSignal: signal }),
        abortSignal,
      );
    } catch (error) {
      if (error?.name === "AbortError" || error?.message === "cancelled")
        throw error;
      phoneAttempt = null;
      state({ stage: "phone" });
      throw sanitizePhoneAuthError(error);
    }
    if (result.status === "challenge") {
      phoneAttempt.challenge = result.challenge;
      state({ stage: "code" });
      return result;
    }
    phoneAttempt = null;
    return result;
  }
  function resumePhoneAuth(phone, challenge, expectedUserId) {
    const normalizedPhone = normalizePhoneNumber(phone);
    if (
      expectedUserId &&
      String(expectedUserId) !== String(storageIdentity || "")
    )
      return false;
    if (
      !challenge ||
      typeof challenge.phoneCodeHash !== "string" ||
      challenge.phoneCodeHash.length === 0 ||
      challenge.phoneCodeHash.length > 1024
    )
      return false;
    const nextTypes = new Set([
      "call",
      "flash_call",
      "fragment",
      "missed_call",
      "sms",
    ]);
    const types = new Set([
      "app",
      "call",
      "email",
      "email_required",
      "firebase",
      "flash_call",
      "fragment",
      "missed_call",
      "sms",
      "sms_phrase",
      "sms_word",
      "unknown",
    ]);
    const timeout =
      Number.isSafeInteger(challenge.timeout) && challenge.timeout >= 0
        ? Math.min(challenge.timeout, 365 * 24 * 60 * 60)
        : 0;
    const challengeState = {
      phoneCodeHash: challenge.phoneCodeHash,
      type: types.has(challenge.type) ? challenge.type : "unknown",
      nextType: nextTypes.has(challenge.nextType) ? challenge.nextType : "none",
      timeout,
      resendAt: Number.isFinite(challenge.resendAt)
        ? challenge.resendAt
        : now() + timeout * 1000,
      length:
        Number.isSafeInteger(challenge.length) && challenge.length > 0
          ? Math.min(challenge.length, 64)
          : 0,
    };
    phoneAttempt = {
      phone: normalizedPhone,
      identity: storageIdentity,
      challenge: challengeState,
    };
    return true;
  }
  function discardPhoneAuth() {
    phoneAttempt = null;
  }
  async function resendPhoneCode(abortSignal) {
    const attempt = phoneAttempt;
    if (!attempt?.challenge || attempt.identity !== storageIdentity)
      throw localPhoneError("RESEND_UNAVAILABLE");
    state({ stage: "busy" });
    try {
      const result = await runAuth(
        (current, signal) =>
          requestPhoneResend(current, attempt.phone, attempt.challenge, {
            abortSignal: signal,
            now,
          }),
        abortSignal,
      );
      if (result.status === "challenge") {
        attempt.challenge = result.challenge;
        state({ stage: "code" });
        return result;
      }
      phoneAttempt = null;
      return result;
    } catch (error) {
      if (error?.name !== "AbortError" && error?.message !== "cancelled")
        state({ stage: "code" });
      throw sanitizePhoneAuthError(error);
    }
  }
  async function signIn(phone, challenge, phoneCode, abortSignal) {
    const attempt = phoneAttempt;
    const normalizedPhone = normalizePhoneNumber(phone);
    if (
      !attempt?.challenge ||
      attempt.identity !== storageIdentity ||
      attempt.phone !== normalizedPhone ||
      attempt.challenge.phoneCodeHash !== challenge?.phoneCodeHash
    )
      throw localPhoneError("PHONE_CODE_EXPIRED");
    try {
      await runAuth(
        (current, signal) =>
          submitPhoneCode(
            current,
            attempt.phone,
            attempt.challenge,
            phoneCode,
            {
              abortSignal: signal,
            },
          ),
        abortSignal,
      );
    } catch (error) {
      if (error?.text === "SESSION_PASSWORD_NEEDED") {
        passwordRequired = true;
        state({ stage: "password" });
        return false;
      }
      if (error?.text === "PHONE_CODE_EXPIRED") phoneAttempt = null;
      throw sanitizePhoneAuthError(error);
    }
    passwordRequired = false;
    phoneAttempt = null;
    return true;
  }
  async function password(value, abortSignal) {
    await runAuth(
      (current, signal) =>
        submitPhonePassword(current, value, { abortSignal: signal }),
      abortSignal,
    );
    passwordRequired = false;
    phoneAttempt = null;
  }
  return {
    restore,
    gameLogin,
    logout,
    cancel,
    phoneCode,
    resumePhoneAuth,
    discardPhoneAuth,
    resendPhoneCode,
    signIn,
    password,
    getClient,
    runAuth,
    get account() {
      return account;
    },
  };
}
