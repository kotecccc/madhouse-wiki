import { refreshRetainedProfileProgress } from "../../../../shared/profile-progress.js";
import {
  telegramContext,
  accountStorageKey,
} from "../../../../shared/telegram-context.js";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { useEffect, useRef, useState } from "react";
import {
  readSession,
  authorizeRequest,
  saveToken,
  clearToken,
  subscribeSession,
  formatExpiry,
} from "../../../../shared/auth-session.js";
import { Skeleton } from "../../../components/ui/Skeleton/Skeleton.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Input } from "../../../components/ui/Input/Input.jsx";
import { TokenBookmarklet } from "./TokenBookmarklet.jsx";
import "./LoginControl.css";
import { normalizePlayerProfile } from "../profile.js";
import {
  TelegramConnection,
  TELEGRAM_CONNECTOR_ORIGIN,
} from "../TelegramConnection/TelegramConnection.jsx";
import {
  AUTO_CONNECT_KEY,
  CONNECTION_EPOCH_KEY,
} from "../../../../shared/telegram-connector.js";

function autoConnectionEnabled() {
  try {
    const stored = window.localStorage.getItem(
      accountStorageKey(AUTO_CONNECT_KEY),
    );
    const userId = telegramContext().userId;
    return userId ? stored === "telegram:" + userId : stored === "1";
  } catch {
    return false;
  }
}

function shouldRestoreTelegramSession() {
  return (
    !!TELEGRAM_CONNECTOR_ORIGIN &&
    (!!telegramContext().initData || autoConnectionEnabled())
  );
}

export function LoginControl() {
  const [session, setSession] = useState(() => readSession());
  const [open, setOpen] = useState(false);
  const [loginMethod, setLoginMethod] = useState("choose");
  const [token, setToken] = useState("");
  const [tokenHelpDevice, setTokenHelpDevice] = useState("computer");
  const [error, setError] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [autoConnect, setAutoConnect] = useState(autoConnectionEnabled);
  const [restoring, setRestoring] = useState(() => {
    const current = readSession();
    return current.status === "ready" || shouldRestoreTelegramSession();
  });
  const [pendingLogin, setPendingLogin] = useState(false);
  const telegramRef = useRef(null);
  const [profile, setProfile] = useState(() => {
    const cached = peekSessionJson("/api/me", { allowStale: true });
    return cached ? normalizePlayerProfile(cached) : null;
  });
  const controlRef = useRef(null);
  const refreshProfileRef = useRef(() => {});
  const progressAttempts = useRef(new Set());
  const authenticated = session.status === "ready";
  useEffect(() => {
    const changed = (event) => {
      if (
        event.key === accountStorageKey(CONNECTION_EPOCH_KEY) ||
        (event.key === accountStorageKey(AUTO_CONNECT_KEY) &&
          !autoConnectionEnabled())
      ) {
        setAutoConnect(false);
        telegramRef.current?.cancel();
      } else if (event.key === accountStorageKey(AUTO_CONNECT_KEY))
        setAutoConnect(autoConnectionEnabled());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (!open || !authenticated) return;
    const outside = (event) => {
      if (!controlRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        controlRef.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, authenticated]);
  useEffect(() => {
    let controller;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      if (readSession().status !== "ready") {
        setProfile(null);
        if (!shouldRestoreTelegramSession()) setRestoring(false);
        return;
      }
      setRestoring(true);
      try {
        const credential = authorizeRequest({ url: "/api/me" }).headers
          .Authorization;
        const data = await getSessionJson("/api/me", {
          signal,
          fresh: true,
          serverRefresh: "live",
        });
        if (!signal.aborted) {
          setProfile(normalizePlayerProfile(data));
          setRestoring(false);
          if (
            !shouldRestoreTelegramSession() &&
            TELEGRAM_CONNECTOR_ORIGIN &&
            !progressAttempts.current.has(credential)
          ) {
            progressAttempts.current.add(credential);
            void refreshRetainedProfileProgress({
              telegramId: data.telegramId,
              request: (id) => telegramRef.current.refreshProgress(id),
              isCurrent: () =>
                !signal.aborted &&
                authorizeRequest({ url: "/api/me" }).headers.Authorization ===
                  credential,
              apply: (progress) =>
                saveToken(credential, {
                  ...progress,
                  activeBossBattle: readSession().activeBossBattle,
                }),
            });
          }
        }
      } catch {
        // A failed or cancelled profile request must not expose credentials.
        if (!signal.aborted) setRestoring(false);
      }
    };
    load();
    refreshProfileRef.current = load;
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.path === "/api/me")
        setProfile(normalizePlayerProfile(event.data));
      if (event.cleared) setProfile(null);
    });
    const unsubscribe = subscribeSession(() => {
      setProfile(null);
      load();
    });
    return () => {
      controller?.abort();
      unsubscribe();
      unsubscribeData();
    };
  }, []);
  useEffect(() => {
    let previousStatus = readSession().status;
    const update = () => {
      const next = readSession();
      if (previousStatus !== next.status) setOpen(false);
      previousStatus = next.status;
      setSession(next);
    };
    const unsubscribe = subscribeSession(update);
    const timer = setInterval(update, 1000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  const close = () => {
    setOpen(false);
    setToken("");
    setError("");
    setConnectionOpen(false);
    setLoginMethod("choose");
  };
  const label = formatExpiry(session);
  const activeProfile = authenticated
    ? profile || {
        name: "Профиль",
        username: "",
      }
    : null;
  const logout = async () => {
    try {
      setAutoConnect(false);
      try {
        window.localStorage.setItem(
          accountStorageKey(CONNECTION_EPOCH_KEY),
          crypto.randomUUID(),
        );
        window.localStorage.removeItem(accountStorageKey(AUTO_CONNECT_KEY));
      } catch {
        /* No secret is stored here. */
      }
      clearToken();
      setSession(readSession());
      close();
      if (TELEGRAM_CONNECTOR_ORIGIN) {
        try {
          await telegramRef.current.logout();
        } catch {
          // Local Wiki sign-out is complete; remote confirmation stays silent.
        }
      }
    } catch (error) {
      setError(
        TELEGRAM_CONNECTOR_ORIGIN
          ? "Не удалось подтвердить полный выход. Повторите попытку и проверьте Telegram → Устройства."
          : error.message,
      );
    }
  };
  const connect = () => {
    setError("");
    setOpen(false);
    setConnectionOpen(true);
    telegramRef.current.connect().catch((error) => {
      setRestoring(false);
      if (error?.message !== "cancelled")
        setError(
          error?.message === "wiki_reopen_required"
            ? "Закройте и откройте Wiki заново через меню бота Telegram."
            : "Не удалось завершить подключение. Повторите попытку.",
        );
    });
  };
  return (
    <>
      <div className="login-control" ref={controlRef}>
        {restoring && !profile ? (
          <div role="status" aria-label="Загружаем профиль" aria-busy="true">
            <Skeleton variant="profile" />
          </div>
        ) : activeProfile ? (
          <BaseCard
            as="button"
            type="button"
            padding="4"
            className="profile-control"
            aria-label={`Профиль: ${activeProfile.name}`}
            aria-expanded={authenticated ? open : undefined}
            aria-controls={
              authenticated && open ? "profile-session" : undefined
            }
            onClick={() => {
              if (authenticated && !open) refreshProfileRef.current();
              setOpen((value) => !value);
            }}
          >
            <ImageCard
              variant="avatar"
              as="span"
              src={activeProfile.avatarUrl}
              alt=""
              size={32}
              imageSize={32}
            >
              <Icon type="character" size="large" />
            </ImageCard>
            <span className="profile-copy">
              <CardTitle as="span" size="xs" className="profile-name">
                {activeProfile.name}
              </CardTitle>
              <CardDescription as="span" size="2xs" className="profile-status">
                {activeProfile.username
                  ? `@${activeProfile.username}`
                  : "Профиль игрока"}
              </CardDescription>
            </span>
            <span className="profile-chevron" aria-hidden="true">
              <Icon type="chevron" size="small" />
            </span>
          </BaseCard>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              setError("");
              setLoginMethod(TELEGRAM_CONNECTOR_ORIGIN ? "choose" : "token");
              setOpen(true);
            }}
          >
            {pendingLogin ? "Продолжить вход" : "Войти"}
          </Button>
        )}
        {open && authenticated && (
          <BaseCard
            variant="popover"
            className="profile-session"
            id="profile-session"
            role="region"
            aria-label="Сеанс пользователя"
          >
            <CardDescription className="profile-session-expiry">
              {label.split(" • ").map((line) => (
                <span key={line}>{line}</span>
              ))}
            </CardDescription>
            {error && <p role="alert">{error}</p>}
            <Button variant="secondary" onClick={logout}>
              Выйти
            </Button>
          </BaseCard>
        )}
      </div>
      {!authenticated && error && !connectionOpen && (
        <p className="login-connection-error" role="alert">
          {error}
        </p>
      )}
      {TELEGRAM_CONNECTOR_ORIGIN && (
        <TelegramConnection
          ref={telegramRef}
          open={connectionOpen}
          error={error}
          autoConnect={autoConnect}
          onRetry={connect}
          onEmpty={() => {
            if (readSession().status !== "empty") clearToken();
            setSession(readSession());
            setPendingLogin(false);
            setRestoring(false);
          }}
          onPending={() => {
            setPendingLogin(true);
            setRestoring(false);
          }}
          onRestoreSettled={() => setRestoring(false)}
          onWarning={() =>
            setError(
              "Не удалось подтвердить отключение Telegram-сессии. Проверьте Telegram → Устройства.",
            )
          }
          onClose={close}
          onBack={() => {
            setConnectionOpen(false);
            setLoginMethod("choose");
            setError("");
            setOpen(true);
          }}
          onToken={(
            value,
            playerLevel,
            currentExp,
            expToNextLevel,
            activeBossBattle,
          ) => {
            saveToken(value, {
              playerLevel,
              currentExp,
              expToNextLevel,
              activeBossBattle,
            });
            try {
              window.localStorage.setItem(
                accountStorageKey(AUTO_CONNECT_KEY),
                telegramContext().userId
                  ? "telegram:" + telegramContext().userId
                  : "1",
              );
            } catch {
              /* JWT storage is checked separately. */
            }
            setAutoConnect(true);
            setPendingLogin(false);
            setSession(readSession());
            close();
          }}
        />
      )}
      {open &&
        !authenticated &&
        TELEGRAM_CONNECTOR_ORIGIN &&
        loginMethod === "choose" && (
          <Modal
            title="Вход в Madhouse Wiki"
            titleId="login-title"
            width={420}
            contentVariant="inset"
            onClose={close}
          >
            <div className="login-modal-actions">
              <Button variant="primary" liftOnHover={false} onClick={connect}>
                {pendingLogin ? "Продолжить вход" : "Войти через Telegram"}
              </Button>
              <Button
                variant="secondary"
                liftOnHover={false}
                onClick={() => setLoginMethod("token")}
              >
                Войти по AccessToken
              </Button>
            </div>
          </Modal>
        )}
      {open && !authenticated && loginMethod === "token" && (
        <Modal
          title="Вход по AccessToken"
          titleId="login-token-title"
          width={400}
          onClose={close}
        >
          <form
            id="login-token-form"
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                saveToken(token);
                setPendingLogin(false);
                setSession(readSession());
                close();
              } catch (error) {
                setError(error.message);
              }
            }}
          >
            <BaseCard
              as="details"
              variant="token-help"
              className="login-token-help"
              aria-label="Инструкция по получению AccessToken"
            >
              <summary className="card-title">Где взять AccessToken?</summary>
              <div
                className="login-token-device-switch"
                role="group"
                aria-label="Выберите устройство"
              >
                <Button
                  variant="toggle"
                  aria-pressed={tokenHelpDevice === "computer"}
                  onClick={() => setTokenHelpDevice("computer")}
                >
                  Компьютер
                </Button>
                <Button
                  variant="toggle"
                  aria-pressed={tokenHelpDevice === "android"}
                  onClick={() => setTokenHelpDevice("android")}
                >
                  Android
                </Button>
                <Button
                  variant="toggle"
                  aria-pressed={tokenHelpDevice === "iphone"}
                  onClick={() => setTokenHelpDevice("iphone")}
                >
                  iPhone
                </Button>
              </div>
              <div className="login-token-help-content">
                {tokenHelpDevice === "computer" ? (
                  <section aria-label="Инструкция для компьютера">
                    <ol>
                      <li>
                        Откройте Telegram Web на сайте{" "}
                        <a
                          href="https://web.telegram.org"
                          target="_blank"
                          rel="noreferrer"
                        >
                          web.telegram.org
                        </a>
                        , найдите чат с игрой и запустите её.
                      </li>
                      <li>
                        Откройте инструменты разработчика: <kbd>F12</kbd> →{" "}
                        <span>Application</span> (в Firefox —{" "}
                        <span>Storage</span>) → <span>Local Storage</span> →{" "}
                        <code>https://cargohustle.online</code>.
                      </li>
                      <li>
                        Скопируйте значение <code>cargo_access_token</code> и
                        вставьте его в поле ниже. Если доступен только{" "}
                        <code>cargo_auth_session</code>, найдите внутри его
                        значения JWT и скопируйте только эту строку. Весь JSON в
                        поле не вставляйте.
                      </li>
                    </ol>
                  </section>
                ) : tokenHelpDevice === "android" ? (
                  <section aria-label="Инструкция для Android">
                    <p className="login-token-phone-copy">
                      <strong>Android — закладка-помощник.</strong> Используйте
                      Firefox или Chrome. В Яндекс Браузере этот способ не
                      работает.
                    </p>
                    <ol>
                      <li>
                        Один раз настройте закладку: добавьте в закладки
                        браузера любой сайт, откройте у закладки «Изменить» и
                        замените адрес кодом закладки-помощника. Задайте
                        короткое имя <code>wiki</code>.
                        <TokenBookmarklet />
                      </li>
                      <li>
                        Откройте в браузере{" "}
                        <a
                          href="https://web.telegram.org"
                          target="_blank"
                          rel="noreferrer"
                        >
                          web.telegram.org
                        </a>{" "}
                        и перейдите в чат, из которого запускаете игру. Саму
                        игру пока не запускайте.
                      </li>
                      <li>
                        Вызовите закладку: нажмите адресную строку, наберите{" "}
                        <code>wiki</code> и выберите закладку в подсказках.
                        Когда она попросит открыть игру, запустите её — вкладка
                        сама перейдёт на страницу игры.
                      </li>
                      <li>
                        Сразу, не дожидаясь загрузки игры, вызовите закладку тем
                        же способом ещё раз. В появившемся окне скопируйте
                        токен, вернитесь сюда и вставьте его в поле ниже.
                      </li>
                    </ol>
                    <p className="login-token-phone-copy">
                      После настройки закладки выполняйте шаги без пауз. Если не
                      получилось, начните заново со второго шага.
                    </p>
                  </section>
                ) : (
                  <section aria-label="Инструкция для iPhone">
                    <p className="login-token-phone-copy">
                      <strong>Подготовьте Safari один раз.</strong> Установите
                      бесплатное расширение Web Inspector из App Store. В Safari
                      нажмите кнопку слева от адреса сайта → «Управлять
                      расширениями» → включите Web Inspector и разрешите ему
                      доступ к сайтам. Если Telegram на телефоне работает только
                      через VPN, включите VPN.
                    </p>
                    <p className="login-token-phone-copy">
                      Перед переходом в Telegram скопируйте код помощника. Он
                      понадобится в консоли Safari на двух шагах.
                      <TokenBookmarklet />
                    </p>
                    <p className="login-token-phone-copy">
                      <strong>Получите токен.</strong> Обычно эти шаги нужно
                      повторять примерно раз в сутки.
                    </p>
                    <ol>
                      <li>
                        В Safari откройте{" "}
                        <a
                          href="https://web.telegram.org/k/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          web.telegram.org/k/
                        </a>
                        , войдите в Telegram и откройте чат с игрой. Пока не
                        нажимайте «Играть».
                      </li>
                      <li>
                        Нажмите кнопку слева от адреса → Web Inspector. В нижней
                        панели выберите вкладку Console. Вставьте скопированный
                        код помощника и нажмите Enter.
                      </li>
                      <li>
                        Вернитесь в чат и нажмите «Играть». Когда Safari
                        перейдёт на страницу игры, сразу снова откройте Web
                        Inspector → Console, вставьте тот же код и нажмите
                        Enter. Не ждите полной загрузки игры.
                      </li>
                      <li>
                        Когда появится окно с токеном, скопируйте его целиком,
                        вернитесь в Wiki и вставьте в поле AccessToken ниже.
                      </li>
                    </ol>
                    <p className="login-token-phone-copy">
                      Если появилось «Игра не пустила (401…)», истекло время:
                      начните сначала, код уже скопирован. Если написано «Эта
                      игра открыта слишком давно», закройте игру и откройте её
                      снова из Telegram.
                    </p>
                  </section>
                )}
              </div>
            </BaseCard>
            {session.status !== "empty" && <p>{label}</p>}
            <Input
              className="login-token-field"
              id="login-jwt"
              type="password"
              autoFocus
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setError("");
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              required
              placeholder="Вставьте JWT AccessToken"
              aria-label="Игровой JWT AccessToken"
            />
            {error && <p role="alert">{error}</p>}
            <div
              className={`login-modal-actions${
                TELEGRAM_CONNECTOR_ORIGIN ? "" : " login-modal-actions--single"
              }`}
            >
              {TELEGRAM_CONNECTOR_ORIGIN && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setError("");
                    setLoginMethod("choose");
                  }}
                >
                  Назад
                </Button>
              )}
              <Button variant="primary" type="submit">
                {TELEGRAM_CONNECTOR_ORIGIN ? "Продолжить" : "Войти"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
