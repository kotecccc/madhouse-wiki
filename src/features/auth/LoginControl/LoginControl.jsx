import { getSessionJson } from "../../../../shared/session-api.js";
import { useEffect, useRef, useState } from "react";
import {
  readSession,
  saveToken,
  clearToken,
  subscribeSession,
  formatExpiry,
} from "../../../../shared/auth-session.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import "./LoginControl.css";
import { profileAvatarUrl } from "../profile.js";
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
    return window.localStorage.getItem(AUTO_CONNECT_KEY) === "1";
  } catch {
    return false;
  }
}

export function LoginControl() {
  const [session, setSession] = useState(() => readSession());
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [autoConnect, setAutoConnect] = useState(autoConnectionEnabled);
  const telegramRef = useRef(null);
  const [profile, setProfile] = useState(null);
  const controlRef = useRef(null);
  const refreshProfileRef = useRef(() => {});
  const authenticated = session.status === "ready";
  useEffect(() => {
    const changed = (event) => {
      if (
        event.key === CONNECTION_EPOCH_KEY ||
        (event.key === AUTO_CONNECT_KEY && event.newValue !== "1")
      ) {
        setAutoConnect(false);
        telegramRef.current?.cancel();
      } else if (event.key === AUTO_CONNECT_KEY)
        setAutoConnect(event.newValue === "1");
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
        return;
      }
      try {
        const data = await getSessionJson("/api/me", { signal });
        const text = (value) =>
          typeof value === "string" ? value.trim().slice(0, 80) : "";
        if (!signal.aborted)
          setProfile({
            name:
              text(data.nickname) ||
              text(data.firstName) ||
              text(data.username) ||
              "Игрок",
            username: text(data.username).replace(/^@/, ""),
            avatarUrl: profileAvatarUrl(data),
            stats: [
              [
                "Безумие",
                data.characterStats?.madness?.total,
                data.characterStats?.maxHealth,
                "HP",
              ],
              [
                "Агрессия",
                data.characterStats?.aggression?.total,
                data.characterStats?.baseDamage,
                "урон",
              ],
              [
                "Ярость",
                data.characterStats?.rage?.total,
                data.characterStats?.critChancePercent,
                "% шанс крита",
              ],
            ].filter(([, value]) => Number.isFinite(value)),
            wallet: [
              ["Монеты", data.wallet?.gold, "coin"],
              ["Пилюли", data.wallet?.pills, "pill"],
              ["Доллары", data.wallet?.dollar, "banknote"],
            ].filter(([, value]) => Number.isFinite(value)),
          });
      } catch {
        // A failed or cancelled profile request must not expose credentials.
      }
    };
    load();
    refreshProfileRef.current = load;
    const unsubscribe = subscribeSession(() => {
      setProfile(null);
      load();
    });
    return () => {
      controller?.abort();
      unsubscribe();
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
  };
  const label = formatExpiry(session);
  const activeProfile = authenticated
    ? profile || { name: "Профиль", username: "" }
    : null;
  const logout = async () => {
    try {
      setAutoConnect(false);
      try {
        window.localStorage.setItem(CONNECTION_EPOCH_KEY, crypto.randomUUID());
        window.localStorage.removeItem(AUTO_CONNECT_KEY);
      } catch {
        /* No secret is stored here. */
      }
      clearToken();
      setSession(readSession());
      close();
      if (TELEGRAM_CONNECTOR_ORIGIN) {
        const result = await telegramRef.current.logout();
        if (!result?.remoteRevoked || !result?.localCleared)
          setError(
            "Игровой вход удалён. Отключение Telegram-сессии не подтверждено полностью — проверьте Telegram → Устройства.",
          );
      }
    } catch (error) {
      setError(
        TELEGRAM_CONNECTOR_ORIGIN
          ? "Не удалось подтвердить отзыв Telegram-сессии. Проверьте Telegram → Устройства."
          : error.message,
      );
    }
  };
  const connect = () => {
    setError("");
    setConnectionOpen(true);
    telegramRef.current.connect().catch((error) => {
      if (error?.message !== "cancelled")
        setError("Не удалось завершить подключение. Повторите попытку.");
    });
  };
  return (
    <>
      <div className="login-control" ref={controlRef}>
        <Button
          variant={activeProfile ? "secondary" : "primary"}
          className={activeProfile ? "profile-control" : undefined}
          aria-label={
            activeProfile ? `Профиль: ${activeProfile.name}` : undefined
          }
          aria-expanded={authenticated ? open : undefined}
          aria-controls={authenticated && open ? "profile-session" : undefined}
          onClick={() => {
            if (!authenticated && TELEGRAM_CONNECTOR_ORIGIN) {
              connect();
              return;
            }
            if (authenticated && !open) refreshProfileRef.current();
            setOpen((value) => !value);
          }}
        >
          {activeProfile ? (
            <>
              <span className="profile-avatar" aria-hidden="true">
                {activeProfile.avatarUrl ? (
                  <img
                    src={activeProfile.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={() =>
                      setProfile((current) =>
                        current?.avatarUrl === activeProfile.avatarUrl
                          ? { ...current, avatarUrl: null }
                          : current,
                      )
                    }
                  />
                ) : (
                  activeProfile.name
                    .replace(/^\[[^\]]+\]\s*/, "")
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => Array.from(part)[0])
                    .join("")
                    .toUpperCase()
                )}
              </span>
              <span className="profile-copy">
                <span className="profile-name">{activeProfile.name}</span>
                <span className="profile-status">
                  {activeProfile.username
                    ? `@${activeProfile.username}`
                    : "Профиль игрока"}
                </span>
              </span>
              <span className="profile-chevron" aria-hidden="true">
                <Icon type="chevron" />
              </span>
            </>
          ) : (
            "Войти"
          )}
        </Button>
        {open && authenticated && (
          <BaseCard
            variant="popover"
            className="profile-session"
            id="profile-session"
            role="region"
            aria-label="Сеанс пользователя"
          >
            {profile && (
              <>
                <dl className="profile-attributes">
                  {(profile.stats || []).map(([name, value, derived, unit]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>
                        {value.toLocaleString("ru-RU")}
                        {Number.isFinite(derived) && (
                          <small>
                            {" "}
                            ({derived.toLocaleString("ru-RU")} {unit})
                          </small>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
                <dl className="profile-stats">
                  {(profile.wallet || []).map(([name, value, icon]) => (
                    <div key={name}>
                      <dt>
                        <Icon type={icon} />
                        {name}
                      </dt>
                      <dd>{value.toLocaleString("ru-RU")}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            <p className="profile-session-expiry">
              {label.split(" · ").map((line) => (
                <span key={line}>{line}</span>
              ))}
            </p>
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
          sessionStatus={session.status}
          autoConnect={autoConnect}
          onRetry={connect}
          onWarning={() =>
            setError(
              "Не удалось подтвердить отключение Telegram-сессии. Проверьте Telegram → Устройства.",
            )
          }
          onClose={() => setConnectionOpen(false)}
          onToken={(value) => {
            saveToken(value);
            try {
              window.localStorage.setItem(AUTO_CONNECT_KEY, "1");
            } catch {
              /* JWT storage is checked separately. */
            }
            setAutoConnect(true);
            setSession(readSession());
            close();
          }}
        />
      )}
      {open && !authenticated && !TELEGRAM_CONNECTOR_ORIGIN && (
        <Modal title="Вход" titleId="login-title" width={400} onClose={close}>
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              try {
                saveToken(token);
                setSession(readSession());
                close();
              } catch (error) {
                setError(error.message);
              }
            }}
          >
            {session.status !== "empty" && <p>{label}</p>}
            <input
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
              placeholder="Вставьте JWT"
              aria-label="Токен для входа"
            />
            {error && <p role="alert">{error}</p>}
            <div className="login-actions">
              <Button variant="primary" type="submit">
                Войти
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
