import { OtpCodeInput } from "../OtpCodeInput/OtpCodeInput.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../src/components/ui/Button/Button.jsx";
import { LoadingStatus } from "../../../src/components/ui/LoadingStatus/LoadingStatus.jsx";
import { CHANNEL, VERSION, createMessageGate } from "../../protocol.js";
import { createConnection } from "../../session.js";
import { connectionFailure, diagnosticSuffix } from "../../diagnostics.js";
import "./ConnectionApp.css";

function hasLevelProgress(value) {
  return (
    Number.isSafeInteger(value?.playerLevel) &&
    value.playerLevel > 0 &&
    Number.isSafeInteger(value?.currentExp) &&
    value.currentExp >= 0 &&
    Number.isSafeInteger(value?.expToNextLevel) &&
    value.expToNextLevel > 0
  );
}

function levelProgressFields(value) {
  return {
    ...(Number.isSafeInteger(value?.playerLevel) && value.playerLevel > 0
      ? { playerLevel: value.playerLevel }
      : {}),
    ...(Number.isSafeInteger(value?.currentExp) &&
    value.currentExp >= 0 &&
    Number.isSafeInteger(value?.expToNextLevel) &&
    value.expToNextLevel > 0
      ? {
          currentExp: value.currentExp,
          expToNextLevel: value.expToNextLevel,
        }
      : {}),
  };
}

const messages = {
  PHONE_NUMBER_INVALID: "Проверьте номер телефона.",
  PHONE_NUMBER_FLOOD:
    "Telegram временно ограничил запросы для этого номера. Попробуйте позже.",
  PHONE_CODE_FLOOD:
    "Telegram временно ограничил запросы кода. Попробуйте позже.",
  PHONE_NUMBER_BANNED: "Telegram временно не разрешает вход для этого номера.",
  PHONE_CODE_INVALID: "Неверный код Telegram.",
  PHONE_CODE_EXPIRED: "Код истёк. Начните вход заново.",
  PASSWORD_HASH_INVALID: "Неверный пароль.",
  API_ID_INVALID: "Подключение временно недоступно.",
  telegram_unavailable: "Не удалось соединиться с Telegram.",
  game_auth_rejected: "Игра не приняла вход. Попробуйте подключиться заново.",
  game_unavailable: "Игра сейчас недоступна.",
  invalid_wiki_identity: "Откройте Wiki заново через меню бота Telegram.",
  game_account_mismatch:
    "Войдите в тот же Telegram-аккаунт, в котором открыта Wiki.",
  session_store_unavailable:
    "Синхронизация входа временно недоступна. Повторите попытку.",
  session_changed: "Сеанс изменился. Повторите подключение.",
  try_later: "Слишком много запросов. Попробуйте позже.",
};
const PENDING_LOGIN_PREFIX = "madhouse-wiki.pending-telegram-login:";
const PENDING_LOGIN_TTL = 10 * 60 * 1000;
const CODE_DELIVERY_TYPES = new Set([
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
  "unknown",
]);
const NEXT_CODE_DELIVERY_TYPES = new Set([
  "sms",
  "call",
  "flash_call",
  "missed_call",
  "fragment",
]);

function normalizeCodeLength(value) {
  return Number.isSafeInteger(value) && value >= 4 && value <= 9 ? value : 5;
}

function normalizeDeliveryType(value) {
  return CODE_DELIVERY_TYPES.has(value) ? value : "unknown";
}

function normalizeNextDeliveryType(value) {
  return NEXT_CODE_DELIVERY_TYPES.has(value) ? value : "none";
}

function normalizeResendAvailableAt(value) {
  return Number.isSafeInteger(value) &&
    value >= Date.now() - PENDING_LOGIN_TTL &&
    value <= Date.now() + 86400 * 1000
    ? value
    : 0;
}

function nextDeliveryLabel(deliveryType) {
  switch (deliveryType) {
    case "sms":
      return "SMS";
    case "call":
      return "автоматический звонок";
    case "flash_call":
    case "missed_call":
      return "звонок";
    case "fragment":
      return "код через Fragment";
    default:
      return "другой способ";
  }
}

function sendCodeErrorMessage(error) {
  const code = error?.text || error?.message;
  const floodWait = typeof code === "string" && /^FLOOD_WAIT_\d+$/.exec(code);
  if (floodWait) {
    const seconds = Number(code.slice("FLOOD_WAIT_".length));
    return seconds < 60
      ? `Telegram просит подождать ${seconds} секунд перед новой попыткой.`
      : `Telegram просит подождать ${Math.ceil(seconds / 60)} минут перед новой попыткой.`;
  }
  return (
    messages[code] || "Не удалось завершить подключение. Повторите попытку."
  );
}

function codeDeliveryInstructions(deliveryType) {
  switch (deliveryType) {
    case "app":
      return "Проверьте служебный чат Telegram на устройстве, где открыт аккаунт этого номера. Код приходит от Telegram, не от бота.";
    case "sms":
      return "Проверьте SMS на указанном номере. В этом случае код может не появиться в чате Telegram.";
    case "call":
      return "Ожидайте автоматический звонок на указанный номер: Telegram продиктует код.";
    case "flash_call":
    case "missed_call":
      return "Проверьте входящий или пропущенный звонок на этом номере и следуйте подсказке Telegram.";
    case "email":
      return "Проверьте адрес электронной почты, привязанный к аккаунту Telegram.";
    case "email_required":
      return "Telegram требует настроить почту для входа. Завершите настройку в официальном приложении Telegram, затем повторите попытку.";
    case "fragment":
      return "Telegram использует Fragment для доставки кода. Следуйте подсказке Telegram для этого номера.";
    case "firebase":
      return "Проверьте SMS на указанном номере и следуйте дальнейшим подсказкам Telegram.";
    case "sms_word":
    case "sms_phrase":
      return "Проверьте SMS: вместо цифр Telegram мог прислать слово или фразу.";
    default:
      return "Проверьте служебный чат Telegram, SMS и другие способы доставки, которые предлагает Telegram.";
  }
}

function pendingLoginKey(expectedUserId) {
  const id = String(expectedUserId || "");
  return /^\d{1,20}$/.test(id) ? PENDING_LOGIN_PREFIX + id : null;
}

function readPendingLogin(expectedUserId) {
  const key = pendingLoginKey(expectedUserId);
  if (!key) return null;
  try {
    const pending = JSON.parse(window.localStorage.getItem(key) || "null");
    const valid =
      pending &&
      pending.userId === String(expectedUserId) &&
      typeof pending.phone === "string" &&
      /^\+[1-9]\d{6,14}$/.test(pending.phone) &&
      typeof pending.phoneCodeHash === "string" &&
      pending.phoneCodeHash.length > 0 &&
      pending.phoneCodeHash.length <= 1024 &&
      ["code", "password"].includes(pending.stage) &&
      Number.isFinite(pending.expiresAt) &&
      pending.expiresAt > Date.now() &&
      pending.expiresAt <= Date.now() + PENDING_LOGIN_TTL + 60000;
    if (valid)
      return {
        ...pending,
        codeLength: normalizeCodeLength(pending.codeLength),
        deliveryType: normalizeDeliveryType(pending.deliveryType),
        nextDeliveryType: normalizeNextDeliveryType(pending.nextDeliveryType),
        resendAvailableAt: normalizeResendAvailableAt(
          pending.resendAvailableAt,
        ),
      };
    window.localStorage.removeItem(key);
  } catch {
    /* Storage may be blocked in some WebViews. */
  }
  return null;
}

function savePendingLogin(
  expectedUserId,
  {
    phone,
    phoneCodeHash,
    stage,
    codeLength,
    deliveryType,
    nextDeliveryType,
    resendAvailableAt,
  },
) {
  const key = pendingLoginKey(expectedUserId);
  if (!key) return false;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        userId: String(expectedUserId),
        phone,
        phoneCodeHash,
        stage,
        codeLength: normalizeCodeLength(codeLength),
        deliveryType: normalizeDeliveryType(deliveryType),
        nextDeliveryType: normalizeNextDeliveryType(nextDeliveryType),
        resendAvailableAt: normalizeResendAvailableAt(resendAvailableAt),
        expiresAt: Date.now() + PENDING_LOGIN_TTL,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function clearPendingLogin(expectedUserId) {
  const key = pendingLoginKey(expectedUserId);
  if (!key) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* An unavailable store cannot supply the pending challenge. */
  }
}

function normalizePhone(value) {
  const phone = String(value || "")
    .trim()
    .replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error("PHONE_NUMBER_INVALID");
  return phone;
}

export function ConnectionApp() {
  const connection = useRef(null),
    currentRequest = useRef(null),
    loginAbort = useRef(null),
    identityProof = useRef(null),
    appRef = useRef(null),
    formRef = useRef(null),
    uiActionHandler = useRef(() => {});
  const [config, setConfig] = useState(null),
    [stage, setStage] = useState("loading");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [qr, setQr] = useState("");
  const [hostedControls, setHostedControls] = useState(false),
    [uiRevision, setUiRevision] = useState(0);
  const [phone, setPhone] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState("");
  const [codeLength, setCodeLength] = useState(5),
    [codeDeliveryType, setCodeDeliveryType] = useState("unknown"),
    [nextCodeDeliveryType, setNextCodeDeliveryType] = useState("none"),
    [resendAvailableAt, setResendAvailableAt] = useState(0),
    [resendClock, setResendClock] = useState(() => Date.now());
  const phoneHash = useRef(null),
    passwordWaiter = useRef(null);
  const reply = useCallback((request, payload, kind = "result") => {
    if (!request || currentRequest.current !== request) return;
    window.parent.postMessage(
      {
        channel: CHANNEL,
        version: VERSION,
        id: request.data.id,
        kind,
        ...payload,
      },
      request.origin,
    );
  }, []);
  const fail = useCallback(
    (error) => setError(sendCodeErrorMessage(error) + diagnosticSuffix(error)),
    [],
  );
  const run = useCallback(
    async (operation, { keepCodeStep = false } = {}) => {
      const request = currentRequest.current;
      setBusy(true);
      setError("");
      try {
        await operation();
      } catch (error) {
        const errorCode = error?.text || error?.message;
        if (
          error?.name !== "AbortError" &&
          error?.message !== "cancelled" &&
          currentRequest.current === request
        ) {
          fail(error);
          if (errorCode === "PHONE_CODE_EXPIRED") {
            clearPendingLogin(request?.data.expectedUserId);
            phoneHash.current = null;
            setCode("");
            setNextCodeDeliveryType("none");
            setResendAvailableAt(0);
            setStage("phone");
          } else if (errorCode === "PHONE_NUMBER_INVALID") {
            setNextCodeDeliveryType("none");
            setResendAvailableAt(0);
            setStage("phone");
          } else if (keepCodeStep) {
            const floodWait =
              typeof errorCode === "string" &&
              /^FLOOD_WAIT_(\d+)$/.exec(errorCode);
            if (floodWait) {
              const resendAt = Date.now() + Number(floodWait[1]) * 1000;
              setResendAvailableAt(resendAt);
              setResendClock(Date.now());
              const pending = readPendingLogin(request?.data.expectedUserId);
              if (pending?.stage === "code")
                savePendingLogin(request.data.expectedUserId, {
                  ...pending,
                  resendAvailableAt: resendAt,
                });
            }
          } else if (
            !["PHONE_CODE_INVALID", "PASSWORD_HASH_INVALID"].includes(errorCode)
          ) {
            setStage("retry");
            reply(request, { status: "failed" });
          }
        }
      } finally {
        if (currentRequest.current === request) setBusy(false);
      }
    },
    [fail, reply],
  );
  const accountSession = useCallback(async (request, action, extra = {}) => {
    if (!request?.data.wikiInitData) return null;
    const response = await fetch("/api/account-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(identityProof.current?.launch === request.data.wikiInitData
          ? { wikiProof: identityProof.current.proof }
          : { wikiInitData: request.data.wikiInitData }),
        action,
        ...extra,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "session_store_unavailable");
    if (typeof data.wikiProof === "string")
      identityProof.current = {
        launch: request.data.wikiInitData,
        proof: data.wikiProof,
      };
    return data;
  }, []);
  const disconnect = useCallback(
    async (request) => {
      // A storage/network failure must not prevent revocation of the local key.
      const [local, shared] = await Promise.allSettled([
        connection.current.logout(),
        accountSession(request, "logout"),
      ]);
      clearPendingLogin(request?.data.expectedUserId);
      const result =
        local.status === "fulfilled"
          ? local.value
          : {
              status: "disconnected",
              remoteRevoked: false,
              localCleared: false,
            };
      return {
        ...result,
        remoteRevoked: result.remoteRevoked && shared.status === "fulfilled",
      };
    },
    [accountSession],
  );
  const complete = useCallback(
    async (request) => {
      if (!request || currentRequest.current !== request) {
        if (request?.freshLogin) {
          clearPendingLogin(request.data.expectedUserId);
          await connection.current.logout();
        }
        return;
      }
      // Restore the signed account's server session BEFORE touching browser IDB.
      const shared = await accountSession(request, "restore");
      if (currentRequest.current !== request) return;
      if (shared?.status === "connected" && hasLevelProgress(shared)) {
        clearPendingLogin(request.data.expectedUserId);
        setCode("");
        setPassword("");
        setPhone("");
        setQr("");
        phoneHash.current = null;
        setNextCodeDeliveryType("none");
        setResendAvailableAt(0);
        request.freshLogin = false;
        reply(request, {
          status: "connected",
          accessToken: shared.accessToken,
          ...levelProgressFields(shared),
        });
        return;
      }
      if (shared?.revoked && !request.data.interactive) {
        reply(request, {
          status: readPendingLogin(request.data.expectedUserId)
            ? "pending"
            : "login-required",
        });
        return;
      }
      const result = await connection.current.gameLogin(
        request.data.expectedUserId,
      );
      if (currentRequest.current !== request) return;
      const connectedProfile =
        result.status === "connected"
          ? {
              ...shared,
              ...result,
              playerLevel: result.playerLevel ?? shared?.playerLevel,
              currentExp: result.currentExp ?? shared?.currentExp,
              expToNextLevel: result.expToNextLevel ?? shared?.expToNextLevel,
            }
          : shared?.status === "connected"
            ? shared
            : null;
      if (result.status === "connected" && shared) {
        await accountSession(request, "save", {
          ticket: shared.ticket,
          accessToken: result.accessToken,
          ...levelProgressFields(connectedProfile),
        });
        if (currentRequest.current !== request) {
          await accountSession(request, "logout");
          return;
        }
      }
      if (connectedProfile) {
        clearPendingLogin(request.data.expectedUserId);
        setCode("");
        setPassword("");
        setPhone("");
        setQr("");
        phoneHash.current = null;
        setNextCodeDeliveryType("none");
        setResendAvailableAt(0);
        request.freshLogin = false;
        reply(request, {
          status: "connected",
          accessToken: connectedProfile.accessToken,
          ...levelProgressFields(connectedProfile),
        });
      } else {
        const pending = readPendingLogin(request.data.expectedUserId);
        if (pending) {
          setPhone(pending.phone);
          setCode("");
          setPassword("");
          setQr("");
          phoneHash.current = pending.phoneCodeHash;
          setCodeLength(pending.codeLength);
          setCodeDeliveryType(pending.deliveryType);
          setNextCodeDeliveryType(pending.nextDeliveryType);
          setResendAvailableAt(pending.resendAvailableAt);
          request.freshLogin = true;
          if (request.data.interactive) {
            setStage(pending.stage);
            return;
          }
          reply(request, { status: "pending" });
          return;
        }
        if (request.data.interactive)
          reply(request, { status: "login-required" }, "interaction-required");
        else reply(request, { status: "login-required" });
      }
    },
    [reply, accountSession],
  );
  useEffect(() => {
    let stopped = false,
      remove = () => {};
    (async () => {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        if (!response.ok) throw new Error();
        const settings = await response.json();
        const {
          TelegramClient,
          MemoryStorage,
          MtTimeoutError,
          MtSecurityError,
          MtUnsupportedError,
        } = await import("@mtcute/web");
        if (stopped) return;
        const conn = createConnection({
          errorTypes: { MtTimeoutError, MtSecurityError, MtUnsupportedError },
          createClient: (storage) =>
            new TelegramClient({
              apiId: settings.apiId,
              apiHash: settings.apiHash,
              storage,
              logLevel: 0,
              disableUpdates: true,
              initConnectionOptions: {
                deviceModel: "Madhouse Wiki",
                appVersion: "1.0.0",
                systemVersion: "Browser",
              },
            }),
          createMemoryClient: () =>
            new TelegramClient({
              apiId: settings.apiId,
              apiHash: settings.apiHash,
              storage: new MemoryStorage(),
              logLevel: 0,
              disableUpdates: true,
              initConnectionOptions: {
                deviceModel: "Madhouse Wiki",
                appVersion: "1.1.0",
                systemVersion: "WebView",
              },
            }),
          exchange: async (initData) => {
            const result = await fetch("/api/game-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ initData }),
              cache: "no-store",
            });
            const data = await result.json();
            if (!result.ok) throw new Error(data.error);
            return {
              accessToken: data.accessToken,
              playerLevel: data.playerLevel,
              currentExp: data.currentExp,
              expToNextLevel: data.expToNextLevel,
            };
          },
          onState: (value) => {
            if (!stopped) setStage(value.stage);
          },
        });
        connection.current = conn;
        setConfig(settings);
        setStage("waiting");
        const accept = createMessageGate({
          origins: settings.wikiOrigins,
          parent: window.parent,
        });
        const listener = (event) => {
          if (!accept(event)) return;
          if (event.data.action === "ui-action") {
            const active = currentRequest.current;
            if (
              !active ||
              active.origin !== event.origin ||
              active.data.id !== event.data.requestId ||
              !active.data.interactive
            )
              return;
            if (event.data.command === "enable-footer") {
              setHostedControls(true);
              setUiRevision((revision) => revision + 1);
            } else uiActionHandler.current(event.data.command);
            return;
          }
          const request = { origin: event.origin, data: event.data };
          if (event.data.action === "cancel") {
            currentRequest.current = null;
            loginAbort.current?.abort();
            conn.cancel();
            setPhone("");
            setCode("");
            setPassword("");
            setQr("");
            phoneHash.current = null;
            setNextCodeDeliveryType("none");
            setResendAvailableAt(0);
            passwordWaiter.current = null;
            setHostedControls(false);
            return;
          }
          currentRequest.current = request;
          setHostedControls(
            event.data.action === "connect-game" &&
              event.data.interactive === true,
          );
          setUiRevision((revision) => revision + 1);
          if (event.data.action === "logout") {
            loginAbort.current?.abort();
            clearPendingLogin(request.data.expectedUserId);
            run(async () => {
              reply(request, await disconnect(request));
            });
          } else if (event.data.action === "status") {
            run(async () =>
              reply(request, {
                status: (await conn.restore(event.data.expectedUserId))
                  ? "connected"
                  : "login-required",
              }),
            );
          } else run(() => complete(request));
        };
        window.addEventListener("message", listener);
        remove = () => window.removeEventListener("message", listener);
        try {
          const parentOrigin = new URL(document.referrer).origin;
          if (
            settings.wikiOrigins.includes(parentOrigin) &&
            window.parent !== window
          )
            window.parent.postMessage(
              { channel: CHANNEL, version: VERSION, kind: "ready" },
              parentOrigin,
            );
        } catch {
          /* A standalone page cannot start a privileged connection. */
        }
      } catch (error) {
        if (!stopped) {
          setStage("unavailable");
          setError(
            "Подключение временно недоступно." +
              diagnosticSuffix(connectionFailure(error, "BOOT")),
          );
        }
      }
    })();
    return () => {
      stopped = true;
      remove();
      loginAbort.current?.abort();
      connection.current?.cancel();
    };
  }, [complete, reply, run, accountSession, disconnect]);

  const startQr = async () => {
    const request = currentRequest.current;
    if (!request?.data.interactive) return;
    request.freshLogin = true;
    loginAbort.current = new AbortController();
    const signal = loginAbort.current.signal;
    const deadline = Date.now() + 180000;
    const { default: QRCode } = await import("qrcode");
    setStage("qr");
    let shown = "";
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      let result;
      try {
        result = await connection.current.runAuth((current) =>
          current.call({
            _: "auth.exportLoginToken",
            apiId: config.apiId,
            apiHash: config.apiHash,
            exceptIds: [],
          }),
        );
        signal.throwIfAborted();
        if (result._ === "auth.loginTokenMigrateTo") {
          await connection.current.runAuth((current) =>
            current.changePrimaryDc(result.dcId),
          );
          const token = result.token;
          result = await connection.current.runAuth((current) =>
            current.call({ _: "auth.importLoginToken", token }),
          );
          signal.throwIfAborted();
        }
      } catch (error) {
        if (error?.text !== "SESSION_PASSWORD_NEEDED") throw error;
        const value = await new Promise((resolve, reject) => {
          passwordWaiter.current = resolve;
          setStage("password");
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        });
        await connection.current.password(value);
        signal.throwIfAborted();
        await complete(request);
        return;
      }
      if (result._ === "auth.loginTokenSuccess") {
        await connection.current.runAuth((current) =>
          current.notifyLoggedIn(result.authorization),
        );
        signal.throwIfAborted();
        await complete(request);
        return;
      }
      if (result._ !== "auth.loginToken") throw new Error();
      const url =
        "tg://login?token=" +
        btoa(String.fromCharCode(...result.token))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      if (url !== shown) {
        setQr(await QRCode.toDataURL(url));
        shown = url;
      }
      await new Promise((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(new DOMException("Cancelled", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, 5000);
        signal.addEventListener("abort", cancel, { once: true });
      });
    }
    setQr("");
    setStage("consent");
    throw new Error("try_later");
  };
  uiActionHandler.current = (command) => {
    const request = currentRequest.current;
    if (!request?.data.interactive) return;
    if (command === "choose-phone") {
      setError("");
      setPhone("");
      setCode("");
      setCodeLength(5);
      setCodeDeliveryType("unknown");
      setNextCodeDeliveryType("none");
      setResendAvailableAt(0);
      setStage("phone");
      return;
    }
    if (command === "choose-qr") {
      setError("");
      run(startQr);
      return;
    }
    if (command === "submit") {
      formRef.current?.requestSubmit();
      return;
    }
    if (command === "logout") {
      run(async () => {
        const result = await connection.current.logout();
        if (!result.remoteRevoked || !result.localCleared)
          setError(
            "Не удалось подтвердить полное отключение. Проверьте Telegram → Настройки → Устройства и завершите сессию Madhouse Wiki.",
          );
        else setStage("consent");
      });
      return;
    }
    if (command !== "back") return;
    if (stage === "phone" || stage === "retry") {
      setError("");
      setStage("consent");
    } else if (stage === "code") {
      clearPendingLogin(request.data.expectedUserId);
      phoneHash.current = null;
      setCode("");
      setError("");
      setNextCodeDeliveryType("none");
      setResendAvailableAt(0);
      setStage("phone");
    } else if (stage === "password") {
      if (passwordWaiter.current) {
        loginAbort.current?.abort();
        passwordWaiter.current = null;
        setQr("");
        setError("");
        setStage("consent");
      } else {
        clearPendingLogin(request.data.expectedUserId);
        phoneHash.current = null;
        setCode("");
        setPassword("");
        setError("");
        setNextCodeDeliveryType("none");
        setResendAvailableAt(0);
        setStage("phone");
      }
    } else if (stage === "qr") {
      loginAbort.current?.abort();
      setQr("");
      setError("");
      setStage("consent");
    }
  };
  const interactive = !!currentRequest.current?.data.interactive;
  const resendSeconds = Math.max(
    0,
    Math.ceil((resendAvailableAt - resendClock) / 1000),
  );
  useEffect(() => {
    if (
      !interactive ||
      stage !== "code" ||
      nextCodeDeliveryType === "none" ||
      resendAvailableAt <= Date.now()
    )
      return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      setResendClock(now);
      if (now >= resendAvailableAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [interactive, stage, nextCodeDeliveryType, resendAvailableAt]);
  const textCode = ["sms_word", "sms_phrase"].includes(codeDeliveryType);
  const codeIsComplete = textCode
    ? code.trim().length > 0
    : code.length === codeLength && /^\d+$/.test(code);
  const normalizedPhone = phone.trim().replace(/[\s().-]/g, "");
  const canSubmit =
    (stage === "phone" && /^\+[1-9]\d{6,14}$/.test(normalizedPhone)) ||
    (stage === "code" &&
      codeIsComplete &&
      codeDeliveryType !== "email_required") ||
    (stage === "password" && password.length > 0);
  useEffect(() => {
    const request = currentRequest.current;
    const node = appRef.current;
    if (!interactive || !request || !node) return;
    const publishUiState = () => {
      window.parent.postMessage(
        {
          channel: CHANNEL,
          version: VERSION,
          kind: "ui-state",
          requestId: request.data.id,
          stage,
          busy,
          canSubmit,
          height: Math.max(1, Math.min(2000, Math.ceil(node.scrollHeight))),
          hostedControls,
        },
        request.origin,
      );
    };
    publishUiState();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(publishUiState);
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    interactive,
    stage,
    busy,
    canSubmit,
    hostedControls,
    uiRevision,
    qr,
    phone,
    code,
    password,
    error,
  ]);
  return (
    <main
      ref={appRef}
      className="connection-app"
      data-hosted-controls={hostedControls || undefined}
    >
      {stage === "loading" && (
        <LoadingStatus>Подготавливаем подключение…</LoadingStatus>
      )}
      {stage === "waiting" && <p>Откройте подключение из Madhouse Wiki.</p>}
      {interactive && ["consent", "wrong-account"].includes(stage) && (
        <section className="connection-consent">
          {stage === "wrong-account" && (
            <h2 className="connection-step-title">Подключён другой аккаунт</h2>
          )}
          <div className="connection-explanation">
            <p>
              <strong>По номеру.</strong> Telegram пришлёт код для входа; если
              включена двухэтапная защита, затем понадобится пароль Telegram.
            </p>
            <p>
              <strong>По QR.</strong> Отсканируйте код другим устройством через
              «Настройки → Устройства → Подключить устройство».
            </p>
            <p>
              После авторизации Wiki сможет сама восстанавливать игровую сессию,
              без ручного копирования токенов.
            </p>
          </div>
          {stage === "wrong-account"
            ? !hostedControls && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => uiActionHandler.current("logout")}
                >
                  Отключить этот аккаунт
                </Button>
              )
            : !hostedControls && (
                <div className="connection-buttons">
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() => uiActionHandler.current("choose-phone")}
                  >
                    Войти по номеру
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => uiActionHandler.current("choose-qr")}
                  >
                    Войти по QR
                  </Button>
                </div>
              )}
        </section>
      )}
      {interactive && stage === "phone" && (
        <form
          ref={formRef}
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            const request = currentRequest.current;
            request.freshLogin = true;
            run(async () => {
              const normalizedPhone = normalizePhone(phone);
              setPhone(normalizedPhone);
              const sentCode =
                await connection.current.phoneCode(normalizedPhone);
              phoneHash.current = sentCode.phoneCodeHash;
              const availableAt =
                sentCode.nextDeliveryType === "none"
                  ? 0
                  : Date.now() + sentCode.timeout * 1000;
              setCodeLength(normalizeCodeLength(sentCode.codeLength));
              setCodeDeliveryType(normalizeDeliveryType(sentCode.deliveryType));
              setNextCodeDeliveryType(
                normalizeNextDeliveryType(sentCode.nextDeliveryType),
              );
              setResendAvailableAt(availableAt);
              setResendClock(Date.now());
              if (phoneHash.current) {
                const stored = savePendingLogin(request.data.expectedUserId, {
                  phone: normalizedPhone,
                  phoneCodeHash: phoneHash.current,
                  stage: "code",
                  codeLength: sentCode.codeLength,
                  deliveryType: sentCode.deliveryType,
                  nextDeliveryType: sentCode.nextDeliveryType,
                  resendAvailableAt: availableAt,
                });
                if (!stored)
                  setError(
                    "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                  );
              }
              if (!phoneHash.current) await complete(request);
            });
          }}
        >
          <label>
            Номер Telegram
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoComplete="tel"
              inputMode="tel"
              placeholder="Введите номер (с кодом)"
              required
            />
          </label>
          {!hostedControls && (
            <Button variant="primary" type="submit" disabled={busy}>
              Получить код
            </Button>
          )}
        </form>
      )}
      {interactive && stage === "code" && (
        <form
          ref={formRef}
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!codeIsComplete || codeDeliveryType === "email_required")
              return;
            const request = currentRequest.current,
              value = textCode ? code.trim() : code;
            setCode("");
            run(async () => {
              if (
                await connection.current.signIn(phone, phoneHash.current, value)
              ) {
                clearPendingLogin(request.data.expectedUserId);
                phoneHash.current = null;
                setNextCodeDeliveryType("none");
                setResendAvailableAt(0);
                await complete(request);
              } else {
                const stored = savePendingLogin(request.data.expectedUserId, {
                  phone,
                  phoneCodeHash: phoneHash.current,
                  stage: "password",
                });
                if (!stored)
                  setError(
                    "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                  );
              }
            });
          }}
        >
          <div className="connection-step-intro">
            <h2 className="connection-step-title">Код Telegram</h2>
            <p>
              {codeDeliveryInstructions(codeDeliveryType)}
              {!textCode && codeDeliveryType !== "email_required"
                ? ` Введите ${codeLength}-значный код.`
                : ""}
            </p>
          </div>
          {textCode ? (
            <label>
              Код Telegram
              <input
                type="text"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                disabled={busy}
              />
            </label>
          ) : codeDeliveryType !== "email_required" ? (
            <OtpCodeInput
              value={code}
              length={codeLength}
              onChange={setCode}
              disabled={busy}
            />
          ) : null}
          {nextCodeDeliveryType === "none" ? (
            <small role="status">
              Telegram не предложил другой способ отправки для этой попытки.
            </small>
          ) : (
            <>
              <small role="status">
                {resendSeconds > 0
                  ? `Запросить ${nextDeliveryLabel(nextCodeDeliveryType)} можно через ${resendSeconds} сек.`
                  : `Если код не пришёл, запросите его через ${nextDeliveryLabel(nextCodeDeliveryType)}.`}
              </small>
              <Button
                variant="secondary"
                type="button"
                disabled={busy || resendSeconds > 0}
                onClick={() => {
                  const request = currentRequest.current;
                  run(
                    async () => {
                      if (!phoneHash.current) return;
                      const sentCode = await connection.current.resendPhoneCode(
                        phone,
                        phoneHash.current,
                      );
                      phoneHash.current = sentCode.phoneCodeHash;
                      const availableAt =
                        sentCode.nextDeliveryType === "none"
                          ? 0
                          : Date.now() + sentCode.timeout * 1000;
                      setCode("");
                      setCodeLength(normalizeCodeLength(sentCode.codeLength));
                      setCodeDeliveryType(
                        normalizeDeliveryType(sentCode.deliveryType),
                      );
                      setNextCodeDeliveryType(
                        normalizeNextDeliveryType(sentCode.nextDeliveryType),
                      );
                      setResendAvailableAt(availableAt);
                      setResendClock(Date.now());
                      const stored = savePendingLogin(
                        request.data.expectedUserId,
                        {
                          phone,
                          phoneCodeHash: phoneHash.current,
                          stage: "code",
                          codeLength: sentCode.codeLength,
                          deliveryType: sentCode.deliveryType,
                          nextDeliveryType: sentCode.nextDeliveryType,
                          resendAvailableAt: availableAt,
                        },
                      );
                      if (!stored)
                        setError(
                          "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                        );
                    },
                    { keepCodeStep: true },
                  );
                }}
              >
                Запросить {nextDeliveryLabel(nextCodeDeliveryType)}
              </Button>
            </>
          )}
          {!hostedControls && (
            <Button
              variant="primary"
              type="submit"
              disabled={busy || !canSubmit}
            >
              Подтвердить вход
            </Button>
          )}
        </form>
      )}
      {interactive && stage === "password" && (
        <form
          ref={formRef}
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            const request = currentRequest.current,
              value = password;
            setPassword("");
            if (passwordWaiter.current) {
              passwordWaiter.current(value);
              passwordWaiter.current = null;
            } else
              run(async () => {
                await connection.current.password(value);
                clearPendingLogin(request.data.expectedUserId);
                phoneHash.current = null;
                await complete(request);
              });
          }}
        >
          <div className="connection-step-intro">
            <h2 className="connection-step-title">Двухэтапная защита</h2>
            <p>Введите пароль Telegram.</p>
          </div>
          <label>
            Пароль двухэтапной аутентификации
            <input
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {!hostedControls && (
            <Button variant="primary" type="submit">
              Подтвердить
            </Button>
          )}
        </form>
      )}
      {interactive && stage === "qr" && qr && (
        <section className="connection-step-panel">
          <div className="connection-qr">
            <p>Telegram → Настройки → Устройства → Подключить устройство</p>
            <img src={qr} alt="QR для входа в Telegram" />
            <LoadingStatus>Ожидаем подтверждение в Telegram…</LoadingStatus>
          </div>
        </section>
      )}
      {busy && stage !== "qr" && <LoadingStatus>Подключаемся…</LoadingStatus>}
      {stage === "connected" && (
        <LoadingStatus>Завершаем вход в игровую сессию…</LoadingStatus>
      )}
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
