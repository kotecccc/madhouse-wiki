import { connectionFailure } from "./diagnostics.js";
import { authErrorCategory } from "./auth-trace.js";

const PHONE_CODE_DELIVERY_TYPES = new Set([
  "app",
  "sms",
  "call",
  "flash_call",
  "missed_call",
  "email",
  "email_required",
  "fragment",
  "firebase",
  "sms_word",
  "sms_phrase",
]);
const NEXT_PHONE_CODE_DELIVERY_TYPES = new Set([
  "sms",
  "call",
  "flash_call",
  "missed_call",
  "fragment",
]);

function codeChallenge(result) {
  const deliveryType = PHONE_CODE_DELIVERY_TYPES.has(result.type)
    ? result.type
    : "unknown";
  const nextDeliveryType = NEXT_PHONE_CODE_DELIVERY_TYPES.has(result.nextType)
    ? result.nextType
    : "none";
  const codeLength =
    Number.isSafeInteger(result.length) &&
    result.length >= 4 &&
    result.length <= 9
      ? result.length
      : 5;
  const timeout =
    Number.isSafeInteger(result.timeout) &&
    result.timeout >= 0 &&
    result.timeout <= 86400
      ? result.timeout
      : 0;

  return {
    phoneCodeHash: result.phoneCodeHash,
    deliveryType,
    codeLength,
    nextDeliveryType,
    timeout,
  };
}

export function createConnection({
  createClient,
  createMemoryClient,
  errorTypes,
  exchange,
  onState = () => {},
  onAuthEvent = () => {},
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
  let accountState = "unknown";
  let passwordRequired = false;
  const authOperations = new Set();
  const state = (value) => onState(value);
  const trace = (value, context) => {
    try {
      return onAuthEvent(value, context);
    } catch {
      /* Diagnostics cannot interrupt login. */
    }
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
      accountState = "unknown";
      passwordRequired = false;
    }
    let stage = "CLIENT";
    try {
      const current = await getClient();
      stage = "RESTORE";
      const self = await current.getMe();
      if (started !== generation) throw new Error("cancelled");
      passwordRequired = false;
      if (expectedUserId && String(self.id) !== expectedUserId) {
        accountState = "wrong-account";
        state({ stage: "wrong-account" });
        return false;
      }
      account = String(self.id);
      accountState = "signed-in";
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
        accountState = "anonymous";
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
        accountState = "anonymous";
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
        trace({ event: "storage-memory", memoryOnly: true });
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
          exchanged = await exchange(initData);
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
      if (started !== generation) throw new Error("cancelled");
      return {
        status: "connected",
        accessToken,
        ...(playerLevel == null ? {} : { playerLevel }),
        ...(currentExp == null || expToNextLevel == null
          ? {}
          : { currentExp, expToNextLevel }),
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
    trace({ event: "cancel", memoryOnly });
    generation++;
    active = null;
  }
  async function runAuth(operation) {
    const started = generation;
    if (cleanup) await cleanup;
    const current = await getClient();
    if (started !== generation) throw new Error("cancelled");
    const task = Promise.resolve().then(() => operation(current));
    authOperations.add(task);
    let result;
    try {
      result = await task;
      if (result?._ === "auth.loginToken" && Number.isFinite(result.expires))
        qrExpires = result.expires * 1000 + 3000;
    } finally {
      authOperations.delete(task);
    }
    if (started !== generation) {
      await logout();
      throw new Error("cancelled");
    }
    return result;
  }
  async function logout() {
    if (cleanup) return cleanup;
    cancel();
    account = null;
    accountState = "unknown";
    passwordRequired = false;
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
  async function phoneCode(phone) {
    state({ stage: "busy" });
    let result;
    try {
      result = await runAuth((current) =>
        tracedCode("send", () => current.sendCode({ phone })),
      );
    } catch (error) {
      state({ stage: "phone" });
      throw error;
    }
    if ("phoneCodeHash" in result) {
      const challenge = codeChallenge(result);
      state({ stage: "code", ...challenge });
      return challenge;
    }
    account = String(result.id);
    return { phoneCodeHash: null, deliveryType: "success", codeLength: 5 };
  }
  async function resendPhoneCode(phone, phoneCodeHash) {
    const result = await runAuth((current) =>
      tracedCode("resend", () => current.resendCode({ phone, phoneCodeHash })),
    );
    const challenge = codeChallenge(result);
    state({ stage: "code", ...challenge });
    return challenge;
  }
  async function tracedCode(operation, invoke) {
    const started = now();
    // Keep the same observer context if the UI switches requests mid-flight.
    const context = trace({
      event: `${operation}-start`,
      memoryOnly,
      accountState,
    });
    try {
      const result = await invoke();
      const details =
        "phoneCodeHash" in result
          ? codeChallenge(result)
          : { deliveryType: "success" };
      const { deliveryType, nextDeliveryType, codeLength, timeout } = details;
      trace(
        {
          event: `${operation}-response`,
          deliveryType,
          ...(nextDeliveryType === undefined
            ? {}
            : { nextDeliveryType, codeLength, timeout }),
          elapsedMs: Math.min(
            3600000,
            Math.max(0, Math.round(now() - started)),
          ),
          memoryOnly,
        },
        context,
      );
      return result;
    } catch (error) {
      trace(
        {
          event: `${operation}-error`,
          errorCategory: authErrorCategory(error),
          memoryOnly,
        },
        context,
      );
      throw error;
    }
  }
  async function signIn(phone, phoneCodeHash, phoneCode) {
    try {
      await runAuth((current) =>
        current.signIn({ phone, phoneCodeHash, phoneCode }),
      );
    } catch (error) {
      if (error?.text === "SESSION_PASSWORD_NEEDED") {
        state({ stage: "password" });
        return false;
      }
      throw error;
    }
    return true;
  }
  async function password(value) {
    await runAuth((current) => current.checkPassword(value));
    passwordRequired = false;
  }
  return {
    restore,
    gameLogin,
    logout,
    cancel,
    phoneCode,
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
