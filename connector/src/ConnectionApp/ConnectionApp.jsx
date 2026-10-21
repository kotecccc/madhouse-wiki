import { OtpCodeInput } from "../OtpCodeInput/OtpCodeInput.jsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../src/components/ui/Button/Button.jsx";
import { BaseCard } from "../../../src/components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../src/components/ui/CardTitle/CardTitle.jsx";
import { CHANNEL, VERSION, createMessageGate } from "../../protocol.js";
import { createConnection } from "../../session.js";
import { connectionFailure, diagnosticSuffix } from "../../diagnostics.js";
import "./ConnectionApp.css";

const messages = {
  PHONE_NUMBER_INVALID: "Проверьте номер телефона.",
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

export function ConnectionApp() {
  const connection = useRef(null),
    currentRequest = useRef(null),
    loginAbort = useRef(null),
    identityProof = useRef(null);
  const [config, setConfig] = useState(null),
    [stage, setStage] = useState("loading");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [qr, setQr] = useState("");
  const [phone, setPhone] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState("");
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
    (error) =>
      setError(
        (messages[error?.text || error?.message] ||
          "Не удалось завершить подключение. Повторите попытку.") +
          diagnosticSuffix(error),
      ),
    [],
  );
  const run = useCallback(
    async (operation) => {
      const request = currentRequest.current;
      setBusy(true);
      setError("");
      try {
        await operation();
      } catch (error) {
        if (
          error?.name !== "AbortError" &&
          error?.message !== "cancelled" &&
          currentRequest.current === request
        ) {
          fail(error);
          if (
            !["PHONE_CODE_INVALID", "PASSWORD_HASH_INVALID"].includes(
              error?.text,
            )
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
        if (request?.freshLogin) await connection.current.logout();
        return;
      }
      setCode("");
      setPassword("");
      setPhone("");
      setQr("");
      phoneHash.current = null;
      // Restore the signed account's server session BEFORE touching browser IDB.
      const shared = await accountSession(request, "restore");
      if (currentRequest.current !== request) return;
      if (shared?.status === "connected") {
        request.freshLogin = false;
        reply(request, {
          status: "connected",
          accessToken: shared.accessToken,
        });
        return;
      }
      if (shared?.revoked && !request.data.interactive) {
        reply(request, { status: "login-required" });
        return;
      }
      const result = await connection.current.gameLogin(
        request.data.expectedUserId,
      );
      if (currentRequest.current !== request) return;
      if (result.status === "connected" && shared) {
        await accountSession(request, "save", {
          ticket: shared.ticket,
          accessToken: result.accessToken,
        });
        if (currentRequest.current !== request) {
          await accountSession(request, "logout");
          return;
        }
      }
      if (result.status === "connected") {
        request.freshLogin = false;
        reply(request, result);
      } else if (request.data.interactive)
        reply(request, { status: "login-required" }, "interaction-required");
      else reply(request, { status: "login-required" });
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
            return data.accessToken;
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
          const request = { origin: event.origin, data: event.data };
          if (event.data.action === "cancel") {
            const cancelled = currentRequest.current;
            currentRequest.current = null;
            loginAbort.current?.abort();
            conn.cancel();
            setPhone("");
            setCode("");
            setPassword("");
            setQr("");
            phoneHash.current = null;
            passwordWaiter.current = null;
            if (cancelled?.freshLogin)
              disconnect(cancelled)
                .then((result) =>
                  window.parent.postMessage(
                    {
                      channel: CHANNEL,
                      version: VERSION,
                      id: event.data.id,
                      kind: "result",
                      ...result,
                    },
                    event.origin,
                  ),
                )
                .catch(() => {});
            return;
          }
          currentRequest.current = request;
          if (event.data.action === "logout") {
            loginAbort.current?.abort();
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
  const interactive = !!currentRequest.current?.data.interactive;
  return (
    <main className="connection-app">
      {stage === "loading" && <p role="status">Подготавливаем подключение…</p>}
      {stage === "waiting" && <p>Откройте подключение из Madhouse Wiki.</p>}
      {interactive && ["consent", "wrong-account"].includes(stage) && (
        <BaseCard className="connection-consent">
          <CardTitle as="h2">
            {stage === "wrong-account"
              ? "Подключён другой аккаунт"
              : "Подключить Telegram"}
          </CardTitle>
          <p className="connection-explanation">
            Один раз войдите в Telegram. Затем Wiki сможет сама получать свежий
            вход в Madhouse, без копирования токенов.
          </p>
          <p className="connection-explanation">
            Это полноценная Telegram-сессия с техническим доступом к аккаунту.
            Она хранится на этом устройстве, если клиент разрешает локальное
            хранилище. Игровая сессия шифруется на сервере и восстанавливается
            на других устройствах этого же Telegram-аккаунта до истечения JWT.
            Полная Telegram-сессия на сервер не отправляется. Отозвать её можно
            через Telegram → Настройки → Устройства или кнопкой «Выйти» в Wiki.
          </p>
          {stage === "wrong-account" ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await connection.current.logout();
                  if (!result.remoteRevoked || !result.localCleared)
                    setError(
                      "Не удалось подтвердить полное отключение. Проверьте Telegram → Настройки → Устройства и завершите сессию Madhouse Wiki.",
                    );
                })
              }
            >
              Отключить этот аккаунт
            </Button>
          ) : (
            <div className="connection-buttons">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => setStage("phone")}
              >
                Войти по номеру
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => run(startQr)}
              >
                Войти по QR
              </Button>
            </div>
          )}
        </BaseCard>
      )}
      {interactive && stage === "phone" && (
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            const request = currentRequest.current;
            request.freshLogin = true;
            run(async () => {
              phoneHash.current = await connection.current.phoneCode(phone);
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
              placeholder="+375…"
              required
            />
          </label>
          <Button variant="primary" type="submit" disabled={busy}>
            Получить код
          </Button>
        </form>
      )}
      {interactive && stage === "code" && (
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!/^[0-9]{5}$/.test(code)) return;
            const request = currentRequest.current,
              value = code;
            setCode("");
            run(async () => {
              if (
                await connection.current.signIn(phone, phoneHash.current, value)
              )
                await complete(request);
            });
          }}
        >
          <p>Введите код из сообщения Telegram.</p>
          <OtpCodeInput value={code} onChange={setCode} disabled={busy} />
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !/^[0-9]{5}$/.test(code)}
          >
            Подтвердить вход
          </Button>
        </form>
      )}
      {interactive && stage === "password" && (
        <form
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
                await complete(request);
              });
          }}
        >
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
          <Button variant="primary" type="submit">
            Подтвердить
          </Button>
        </form>
      )}
      {interactive && stage === "qr" && qr && (
        <div className="connection-qr">
          <p>Telegram → Настройки → Устройства → Подключить устройство</p>
          <img src={qr} alt="QR для входа в Telegram" />
        </div>
      )}
      {(busy || stage === "connected") && <p role="status">Подключаемся…</p>}
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
