import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../src/components/ui/Button/Button.jsx";
import { ErrorToast } from "../../../src/components/ui/ErrorToast/ErrorToast.jsx";
import { FieldLabel } from "../../../src/components/ui/FieldLabel/FieldLabel.jsx";
import { Input } from "../../../src/components/ui/Input/Input.jsx";
import { LoadingStatus } from "../../../src/components/ui/LoadingStatus/LoadingStatus.jsx";
import { Title } from "../../../src/components/ui/Title/Title.jsx";
import { CHANNEL, VERSION, createMessageGate } from "../../protocol.js";
import { normalizePhoneNumber } from "../../phone-auth.js";
import { createConnection } from "../../session.js";
import { connectionFailure, diagnosticSuffix } from "../../diagnostics.js";
import "./ConnectionApp.css";

const messages = {
  AUTH_FAILED: "Не удалось выполнить вход. Попробуйте ещё раз или выберите QR.",
  PHONE_NUMBER_INVALID: "Проверьте номер телефона.",
  PHONE_CODE_INVALID: "Неверный код Telegram.",
  PHONE_CODE_EXPIRED: "Код истёк. Начните вход заново.",
  PHONE_CODE_EMPTY: "Введите код Telegram.",
  PHONE_CODE_FLOOD:
    "Telegram ограничил проверку кода. Попробуйте позже или выберите QR.",
  PHONE_NUMBER_BANNED:
    "Telegram не разрешил вход для этого номера. Попробуйте QR.",
  PHONE_NUMBER_FLOOD:
    "Telegram ограничил запросы для этого номера. Попробуйте позже или выберите QR.",
  PHONE_NUMBER_UNOCCUPIED:
    "Этот номер не привязан к существующему аккаунту Telegram.",
  PHONE_NUMBER_APP_SIGNUP_FORBIDDEN:
    "Создание аккаунта по номеру здесь недоступно. Используйте существующий аккаунт Telegram.",
  PASSWORD_HASH_INVALID: "Неверный пароль.",
  SRP_ID_INVALID: "Шаг двухэтапной защиты устарел. Начните вход заново.",
  API_ID_INVALID: "Подключение временно недоступно.",
  API_ID_PUBLISHED_FLOOD: "Подключение временно ограничено Telegram.",
  SMS_CODE_CREATE_FAILED:
    "Telegram не смог подготовить код. Попробуйте позже или выберите QR.",
  PAYMENT_REQUIRED:
    "Telegram требует предварительный вход через официальный клиент.",
  RESEND_UNAVAILABLE: "Telegram не предложил другой способ для этого запроса.",
  telegram_unavailable: "Не удалось соединиться с Telegram.",
  game_auth_rejected: "Игра не приняла вход. Попробуйте подключиться заново.",
  game_auth_unknown:
    "Сервер не смог подтвердить исход игрового входа. Повторная отправка этого входа заблокирована; обратитесь в поддержку Wiki.",
  game_auth_busy:
    "Для аккаунта уже выполняется или восстанавливается игровой вход. Подождите и проверьте состояние позже.",
  game_unavailable: "Игра сейчас недоступна.",
  invalid_game_session:
    "Wiki не смогла подтвердить этот игровой сеанс. Подключитесь заново.",
  bridge_auth_required:
    "Для выбранного устройства обновите игровой вход через Madhouse Connect в управлении устройствами Wiki.",
  bridge_route_unavailable:
    "Не удалось проверить маршрут Wiki. Обновите страницу и повторите подключение.",
  invalid_wiki_identity: "Откройте Wiki заново через меню бота Telegram.",
  game_account_mismatch:
    "Войдите в тот же Telegram-аккаунт, в котором открыта Wiki.",
  game_account_already_bound:
    "Этот игровой аккаунт уже привязан к другой учётной записи Wiki.",
  game_account_binding_conflict:
    "В этой Wiki уже подтверждён другой игровой аккаунт.",
  game_account_binding_unavailable:
    "Не удалось проверить привязку игрового аккаунта. Повторите попытку позже.",
  session_store_unavailable:
    "Синхронизация входа временно недоступна. Повторите попытку.",
  session_changed: "Сеанс изменился. Повторите подключение.",
  try_later: "Слишком много запросов. Попробуйте позже.",
};
const PENDING_LOGIN_PREFIX = "madhouse-wiki.pending-telegram-login:";
const PENDING_LOGIN_TTL = 10 * 60 * 1000;
const pendingDeliveryTypes = new Set([
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
const pendingNextTypes = new Set([
  "call",
  "flash_call",
  "fragment",
  "missed_call",
  "sms",
]);
const deliveryLabels = {
  app: "сообщение Telegram",
  call: "звонок",
  email: "электронная почта",
  email_required: "настройка адреса электронной почты",
  firebase: "SMS с системной проверкой",
  flash_call: "проверка по звонку",
  fragment: "Fragment",
  missed_call: "пропущенный звонок",
  sms: "SMS",
  sms_phrase: "фраза в SMS",
  sms_word: "слово в SMS",
  unknown: "способ, выбранный Telegram",
};

function deliveryLabel(type) {
  return deliveryLabels[type] || deliveryLabels.unknown;
}

function waitLabel(seconds) {
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `${minutes} мин.`;
  }
  return `${seconds} сек.`;
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
    if (valid) {
      const timeout =
        Number.isSafeInteger(pending.timeout) && pending.timeout >= 0
          ? Math.min(pending.timeout, 365 * 24 * 60 * 60)
          : 0;
      return {
        ...pending,
        challenge: {
          phoneCodeHash: pending.phoneCodeHash,
          type: pendingDeliveryTypes.has(pending.type)
            ? pending.type
            : "unknown",
          nextType: pendingNextTypes.has(pending.nextType)
            ? pending.nextType
            : "none",
          timeout,
          resendAt: Number.isFinite(pending.resendAt)
            ? pending.resendAt
            : Date.now(),
          length:
            Number.isSafeInteger(pending.length) && pending.length > 0
              ? Math.min(pending.length, 64)
              : 0,
        },
      };
    }
    window.localStorage.removeItem(key);
  } catch {
    /* Storage may be blocked in some WebViews. */
  }
  return null;
}

function savePendingLogin(expectedUserId, { phone, challenge, stage }) {
  const key = pendingLoginKey(expectedUserId);
  if (!key) return false;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({
        userId: String(expectedUserId),
        phone,
        phoneCodeHash: challenge.phoneCodeHash,
        type: challenge.type,
        nextType: challenge.nextType,
        timeout: challenge.timeout,
        resendAt: challenge.resendAt,
        length: challenge.length,
        stage,
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
  const [delivery, setDelivery] = useState(null),
    [authCooldownUntil, setAuthCooldownUntil] = useState(0),
    [currentTime, setCurrentTime] = useState(Date.now());
  const phoneChallenge = useRef(null),
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
  const fail = useCallback((error) => {
    const code = error?.text || error?.message;
    const waitSeconds = Math.max(0, Math.ceil(error?.waitSeconds || 0));
    const message =
      code === "FLOOD_WAIT"
        ? waitSeconds > 0
          ? `Telegram просит подождать ${waitSeconds} сек. перед следующей попыткой.`
          : "Telegram временно ограничил запросы. Попробуйте позже."
        : code === "RESEND_WAIT"
          ? `Подождите ещё ${waitSeconds} сек. перед запросом следующего способа.`
          : messages[code] ||
            "Не удалось завершить подключение. Повторите попытку.";
    setError(message + diagnosticSuffix(error));
  }, []);
  const run = useCallback(
    async (operation, { abortable = false } = {}) => {
      const request = currentRequest.current;
      const controller = abortable ? new AbortController() : null;
      if (controller) loginAbort.current = controller;
      setBusy(true);
      setError("");
      try {
        await operation(controller?.signal);
      } catch (error) {
        const errorCode = error?.text || error?.message;
        if (
          error?.name !== "AbortError" &&
          error?.message !== "cancelled" &&
          currentRequest.current === request
        ) {
          fail(error);
          if (["FLOOD_WAIT", "RESEND_WAIT"].includes(errorCode))
            setAuthCooldownUntil(
              Date.now() + Math.max(0, error.waitSeconds || 0) * 1000,
            );
          if (errorCode === "PHONE_CODE_EXPIRED") {
            clearPendingLogin(request?.data.expectedUserId);
            connection.current?.discardPhoneAuth();
            phoneChallenge.current = null;
            setDelivery(null);
            setCode("");
            setStage("phone");
          } else if (errorCode === "PHONE_NUMBER_INVALID") {
            setStage("phone");
          } else if (
            [
              "PHONE_CODE_FLOOD",
              "PHONE_NUMBER_FLOOD",
              "PHONE_NUMBER_BANNED",
            ].includes(errorCode)
          ) {
            clearPendingLogin(request?.data.expectedUserId);
            connection.current?.discardPhoneAuth();
            phoneChallenge.current = null;
            setDelivery(null);
            setCode("");
            setStage("retry");
            reply(request, { status: "failed" });
          } else if (
            [
              "PHONE_CODE_INVALID",
              "PHONE_CODE_EMPTY",
              "PASSWORD_HASH_INVALID",
              "FLOOD_WAIT",
              "RESEND_WAIT",
            ].includes(errorCode)
          ) {
            // Keep the current form open for an explicit user retry.
          } else if (errorCode !== "RESEND_UNAVAILABLE") {
            setStage("retry");
            reply(request, { status: "failed" });
          }
        }
      } finally {
        if (controller && loginAbort.current === controller)
          loginAbort.current = null;
        if (currentRequest.current === request) setBusy(false);
      }
    },
    [fail, reply],
  );
  useEffect(() => {
    const resendDeadline =
      delivery?.nextType && delivery.nextType !== "none"
        ? delivery.resendAt
        : 0;
    const deadline = Math.max(authCooldownUntil, resendDeadline || 0);
    const current = Date.now();
    setCurrentTime(current);
    if (deadline <= current) return;
    const timer = setInterval(() => {
      const timestamp = Date.now();
      setCurrentTime(timestamp);
      if (timestamp >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [authCooldownUntil, delivery?.nextType, delivery?.resendAt]);
  const accountSession = useCallback(async (request, action, extra = {}) => {
    if (!request?.data.wikiInitData) return null;
    const cachedProof =
      identityProof.current?.launch === request.data.wikiInitData
        ? identityProof.current.proof
        : null;
    const identity =
      action === "logout" && cachedProof
        ? { wikiProof: cachedProof }
        : {
            wikiInitData: request.data.wikiInitData,
            ...(cachedProof ? { wikiProof: cachedProof } : {}),
          };
    const response = await fetch("/api/account-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...identity,
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
  const gameSessionStatus = useCallback(async (request) => {
    if (!request?.data.wikiInitData) return { status: "login-required" };
    const response = await fetch("/api/game-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "status",
        wikiInitData: request.data.wikiInitData,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "bridge_route_unavailable");
    return data;
  }, []);
  const gameSessionLogout = useCallback(async (request) => {
    if (!request?.data.wikiInitData) return null;
    const response = await fetch("/api/game-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "logout",
        wikiInitData: request.data.wikiInitData,
      }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "game_logout_unavailable");
    return data;
  }, []);
  const disconnect = useCallback(
    async (request) => {
      // A storage/network failure must not prevent revocation of the local key.
      const [local, shared, game] = await Promise.allSettled([
        connection.current.logout(),
        accountSession(request, "logout"),
        gameSessionLogout(request),
      ]);
      clearPendingLogin(request?.data.expectedUserId);
      phoneChallenge.current = null;
      setDelivery(null);
      setCode("");
      setPassword("");
      setPhone("");
      setAuthCooldownUntil(0);
      const result =
        local.status === "fulfilled"
          ? local.value
          : {
              status: "disconnected",
              remoteRevoked: false,
              localCleared: false,
            };
      const gameLogoutConfirmed =
        game.status === "fulfilled" &&
        game.value?.status === "disconnected" &&
        game.value?.serverManaged === true;
      return {
        ...result,
        remoteRevoked:
          result.remoteRevoked &&
          shared.status === "fulfilled" &&
          gameLogoutConfirmed,
      };
    },
    [accountSession, gameSessionLogout],
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
      // Ask Wiki whether its private server-side game session is ready before
      // opening a new Telegram game session.
      const shared = request.data.restoreRequestId
        ? null
        : await gameSessionStatus(request);
      if (currentRequest.current !== request) return;
      if (shared?.status === "connected" && shared.serverManaged === true) {
        clearPendingLogin(request.data.expectedUserId);
        setCode("");
        setPassword("");
        setPhone("");
        setQr("");
        phoneChallenge.current = null;
        setDelivery(null);
        connection.current.discardPhoneAuth();
        setAuthCooldownUntil(0);
        request.freshLogin = false;
        reply(request, { status: "connected", serverManaged: true });
        return;
      }
      if (shared?.status === "pending") {
        reply(request, { status: "pending" });
        return;
      }
      if (!request.data.interactive) {
        reply(request, { status: "login-required" });
        return;
      }
      const result = await connection.current.gameLogin(
        request.data.expectedUserId,
      );
      if (currentRequest.current !== request) return;
      if (result.status === "password-required") {
        clearPendingLogin(request.data.expectedUserId);
        connection.current.discardPhoneAuth();
        phoneChallenge.current = null;
        setDelivery(null);
        passwordWaiter.current = null;
        setCode("");
        setPassword("");
        setAuthCooldownUntil(0);
        if (request.data.interactive) {
          request.freshLogin = true;
          setStage("password");
        } else reply(request, { status: "pending" });
        return;
      }
      if (result.status === "pending") {
        reply(request, { status: "pending" });
        return;
      }
      if (result.status === "connected" && result.serverManaged === true) {
        clearPendingLogin(request.data.expectedUserId);
        setCode("");
        setPassword("");
        setPhone("");
        setQr("");
        phoneChallenge.current = null;
        setDelivery(null);
        connection.current.discardPhoneAuth();
        setAuthCooldownUntil(0);
        request.freshLogin = false;
        reply(request, { status: "connected", serverManaged: true });
      } else {
        const pending = readPendingLogin(request.data.expectedUserId);
        if (
          pending &&
          connection.current.resumePhoneAuth(
            pending.phone,
            pending.challenge,
            request.data.expectedUserId,
          )
        ) {
          setPhone(pending.phone);
          setCode("");
          setPassword("");
          setQr("");
          phoneChallenge.current = pending.challenge;
          setDelivery(pending.challenge);
          request.freshLogin = true;
          if (request.data.interactive) {
            setStage(pending.stage);
            return;
          }
          reply(request, { status: "pending" });
          return;
        }
        if (pending) clearPendingLogin(request.data.expectedUserId);
        if (request.data.interactive)
          reply(request, { status: "login-required" }, "interaction-required");
        else reply(request, { status: "login-required" });
      }
    },
    [reply, gameSessionStatus],
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
            const wikiInitData = currentRequest.current?.data?.wikiInitData;
            const restoreRequestId =
              currentRequest.current?.data?.restoreRequestId;
            const result = await fetch("/api/game-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                initData,
                ...(restoreRequestId
                  ? { action: "restore", restoreRequestId }
                  : {}),
                ...(typeof wikiInitData === "string" ? { wikiInitData } : {}),
              }),
              cache: "no-store",
            });
            const data = await result.json();
            if (!result.ok) throw new Error(data.error);
            return {
              ...(data.status === "pending" ? { status: "pending" } : {}),
              ...(data.serverManaged === true ? { serverManaged: true } : {}),
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
            conn.discardPhoneAuth();
            phoneChallenge.current = null;
            setDelivery(null);
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
        await connection.current.password(value, signal);
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
      clearPendingLogin(request.data.expectedUserId);
      connection.current.discardPhoneAuth();
      phoneChallenge.current = null;
      setDelivery(null);
      setError("");
      setPhone("");
      setCode("");
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
            "Не удалось подтвердить полный выход. Проверьте Telegram → Настройки → Устройства и игровой сеанс в Wiki.",
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
      connection.current.discardPhoneAuth();
      phoneChallenge.current = null;
      setDelivery(null);
      setCode("");
      setError("");
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
        connection.current.discardPhoneAuth();
        phoneChallenge.current = null;
        setDelivery(null);
        setCode("");
        setPassword("");
        setError("");
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
  const normalizedPhone = phone.trim().replace(/[\s().-]/g, "");
  const cooldownSeconds = Math.max(
    0,
    Math.ceil((authCooldownUntil - currentTime) / 1000),
  );
  const resendSeconds =
    delivery?.nextType && delivery.nextType !== "none"
      ? Math.max(0, Math.ceil((delivery.resendAt - currentTime) / 1000))
      : 0;
  const codeReady =
    !!delivery &&
    delivery.type !== "email_required" &&
    (delivery.length
      ? code.trim().length === delivery.length
      : code.trim().length > 0);
  const numericCode = [
    "app",
    "call",
    "firebase",
    "flash_call",
    "fragment",
    "missed_call",
    "sms",
  ].includes(delivery?.type);
  const codeInstruction =
    delivery?.type === "sms_word"
      ? "Введите слово из сообщения Telegram."
      : delivery?.type === "sms_phrase"
        ? "Введите фразу из сообщения Telegram."
        : delivery?.type === "email"
          ? "Введите код, если он появится на выбранном Telegram адресе."
          : "Введите код, если вы его получили.";
  const canSubmit =
    (stage === "phone" &&
      /^\+[1-9]\d{6,14}$/.test(normalizedPhone) &&
      cooldownSeconds === 0) ||
    (stage === "code" && codeReady && cooldownSeconds === 0) ||
    (stage === "password" && password.length > 0 && cooldownSeconds === 0);
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
    delivery,
    currentTime,
    authCooldownUntil,
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
            <Title as="h5">Подключён другой аккаунт</Title>
          )}
          <div className="connection-explanation">
            <p>
              <strong>По номеру.</strong> Telegram выберет доступный способ
              проверки. Wiki не может подтвердить, что сообщение с кодом было
              доставлено. При включённой двухэтапной защите потребуется пароль.
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
            run(
              async (signal) => {
                const normalizedPhone = normalizePhoneNumber(phone);
                setPhone(normalizedPhone);
                const result = await connection.current.phoneCode(
                  normalizedPhone,
                  signal,
                );
                if (result.status === "challenge") {
                  phoneChallenge.current = result.challenge;
                  setDelivery(result.challenge);
                  setAuthCooldownUntil(0);
                  setStage("code");
                  const stored = savePendingLogin(request.data.expectedUserId, {
                    phone: normalizedPhone,
                    challenge: result.challenge,
                    stage: "code",
                  });
                  if (!stored)
                    setError(
                      "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                    );
                } else {
                  phoneChallenge.current = null;
                  setDelivery(null);
                  await complete(request);
                }
              },
              { abortable: true },
            );
          }}
        >
          <div className="connection-form-field">
            <FieldLabel htmlFor="telegram-phone">Номер Telegram</FieldLabel>
            <Input
              id="telegram-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              autoComplete="tel"
              inputMode="tel"
              placeholder="Введите номер (с кодом)"
              required
            />
          </div>
          {cooldownSeconds > 0 && (
            <p>
              Повторный запрос будет доступен через {waitLabel(cooldownSeconds)}
              .
            </p>
          )}
          {!hostedControls && (
            <Button
              variant="primary"
              type="submit"
              disabled={busy || cooldownSeconds > 0 || !canSubmit}
            >
              Получить код
            </Button>
          )}
        </form>
      )}
      {interactive && stage === "code" && delivery && (
        <section className="connection-step-panel">
          <div className="connection-step-intro">
            <Title as="h5">
              {delivery.type === "email_required"
                ? "Нужна дополнительная проверка"
                : "Проверка Telegram"}
            </Title>
            {delivery.type === "email_required" ? (
              <p>
                Telegram требует настроить адрес электронной почты в официальном
                приложении. Завершите проверку там и начните вход заново.
              </p>
            ) : (
              <>
                <p>{codeInstruction}</p>
                <p>
                  Telegram выбрал сценарий: {deliveryLabel(delivery.type)}. Это
                  не подтверждает доставку сообщения.
                </p>
              </>
            )}
          </div>
          {delivery.type !== "email_required" && (
            <form
              ref={formRef}
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!codeReady || !phoneChallenge.current) return;
                const request = currentRequest.current;
                const value = code.trim();
                const challenge = phoneChallenge.current;
                setCode("");
                run(
                  async (signal) => {
                    if (
                      await connection.current.signIn(
                        phone,
                        challenge,
                        value,
                        signal,
                      )
                    ) {
                      clearPendingLogin(request.data.expectedUserId);
                      phoneChallenge.current = null;
                      setDelivery(null);
                      setAuthCooldownUntil(0);
                      await complete(request);
                    } else {
                      const stored = savePendingLogin(
                        request.data.expectedUserId,
                        {
                          phone,
                          challenge,
                          stage: "password",
                        },
                      );
                      if (!stored)
                        setError(
                          "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                        );
                    }
                  },
                  { abortable: true },
                );
              }}
            >
              <div className="connection-form-field">
                <FieldLabel htmlFor="telegram-code">
                  Код или текст проверки
                </FieldLabel>
                <Input
                  id="telegram-code"
                  type="text"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  autoComplete="one-time-code"
                  inputMode={numericCode ? "numeric" : "text"}
                  maxLength={delivery.length || 64}
                  disabled={busy || cooldownSeconds > 0}
                  required
                />
              </div>
              {cooldownSeconds > 0 && (
                <p>
                  Telegram просит подождать ещё {waitLabel(cooldownSeconds)}.
                </p>
              )}
              {!hostedControls && (
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy || !codeReady || cooldownSeconds > 0}
                >
                  Подтвердить вход
                </Button>
              )}
            </form>
          )}
          {delivery.nextType !== "none" ? (
            <div className="connection-code-resend">
              <p>
                Telegram указал следующий способ:{" "}
                {deliveryLabel(delivery.nextType)}.
                {resendSeconds > 0
                  ? ` Его можно запросить через ${waitLabel(resendSeconds)}.`
                  : " Его можно запросить вручную."}
              </p>
              <Button
                variant="secondary"
                disabled={busy || cooldownSeconds > 0 || resendSeconds > 0}
                onClick={() => {
                  const request = currentRequest.current;
                  run(
                    async (signal) => {
                      const result =
                        await connection.current.resendPhoneCode(signal);
                      if (result.status === "challenge") {
                        phoneChallenge.current = result.challenge;
                        setDelivery(result.challenge);
                        setAuthCooldownUntil(0);
                        setCode("");
                        const stored = savePendingLogin(
                          request.data.expectedUserId,
                          {
                            phone,
                            challenge: result.challenge,
                            stage: "code",
                          },
                        );
                        if (!stored)
                          setError(
                            "Не удалось сохранить шаг входа на этом устройстве. Оставьте Wiki открытой до завершения авторизации.",
                          );
                        setStage("code");
                      } else {
                        clearPendingLogin(request.data.expectedUserId);
                        phoneChallenge.current = null;
                        setDelivery(null);
                        await complete(request);
                      }
                    },
                    { abortable: true },
                  );
                }}
              >
                {resendSeconds > 0
                  ? `Попробовать ${deliveryLabel(delivery.nextType)} через ${waitLabel(resendSeconds)}`
                  : `Попробовать ${deliveryLabel(delivery.nextType)}`}
              </Button>
            </div>
          ) : (
            <p>Telegram не указал дополнительный способ для этого запроса.</p>
          )}
        </section>
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
              run(
                async (signal) => {
                  await connection.current.password(value, signal);
                  clearPendingLogin(request.data.expectedUserId);
                  phoneChallenge.current = null;
                  setDelivery(null);
                  setAuthCooldownUntil(0);
                  await complete(request);
                },
                { abortable: true },
              );
          }}
        >
          <div className="connection-form-field">
            <FieldLabel htmlFor="telegram-password">
              Пароль двухэтапной аутентификации
            </FieldLabel>
            <Input
              id="telegram-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={busy && !passwordWaiter.current}
              required
            />
          </div>
          {!hostedControls && (
            <Button
              variant="primary"
              type="submit"
              disabled={
                (busy && !passwordWaiter.current) ||
                cooldownSeconds > 0 ||
                password.length === 0
              }
            >
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
      {stage === "connected" && (
        <LoadingStatus>Завершаем вход в игровую сессию…</LoadingStatus>
      )}
      <ErrorToast message={error} />
    </main>
  );
}
