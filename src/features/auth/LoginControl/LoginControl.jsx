import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import {
  telegramContext,
  accountStorageKey,
} from "../../../../shared/telegram-context.js";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { floorAutomation } from "../../bosses/BossBattle/boss-battle-session.js";
import {
  readSession,
  saveServerManagedSession,
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
import "./LoginControl.css";
import { normalizePlayerProfile } from "../profile.js";
import {
  TelegramConnection,
  TELEGRAM_CONNECTOR_ORIGIN,
} from "../TelegramConnection/TelegramConnection.jsx";
import { DeviceManagerDialog } from "../DeviceManager/DeviceManagerDialog.jsx";
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
  const floor = useSyncExternalStore(
    floorAutomation.subscribe,
    floorAutomation.getSnapshot,
    floorAutomation.getSnapshot,
  );
  const [session, setSession] = useState(() => readSession());
  const [open, setOpen] = useState(false);
  const [buddyCount, setBuddyCount] = useState(0);
  const [error, setError] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const [autoConnect, setAutoConnect] = useState(autoConnectionEnabled);
  const [restoring, setRestoring] = useState(() => {
    const current = readSession();
    return current.status === "ready" || shouldRestoreTelegramSession();
  });
  const [pendingLogin, setPendingLogin] = useState(false);
  const telegramRef = useRef(null);
  const restoreRequestRef = useRef(null);
  const [profile, setProfile] = useState(() => {
    const cached = peekSessionJson("/api/me", { allowStale: true });
    return cached ? normalizePlayerProfile(cached) : null;
  });
  const controlRef = useRef(null);
  const refreshProfileRef = useRef(() => {});
  const authenticated = session.status === "ready";
  const hasTelegramInitData = Boolean(telegramContext().initData);
  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const loadBuddy = async () => {
      const current = ++generation;
      if (readSession().status !== "ready") {
        setBuddyCount(0);
        return;
      }
      try {
        const value = await getSessionJson("/api/automation/state", {
          fresh: true,
          revalidate: false,
        });
        if (!cancelled && current === generation)
          setBuddyCount(
            value.buddy?.mode === "buddy" && value.buddy.enabled
              ? (value.buddy.friendIds?.length ?? 0)
              : 0,
          );
      } catch {
        if (!cancelled && current === generation) setBuddyCount(0);
      }
    };
    const unsubscribe = subscribeSession(() => {
      setBuddyCount(0);
      void loadBuddy();
    });
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.cleared) setBuddyCount(0);
      else if (event.path === "/api/automation/state") {
        const buddy = event.data?.buddy;
        setBuddyCount(
          buddy?.mode === "buddy" && buddy.enabled
            ? (buddy.friendIds?.length ?? 0)
            : 0,
        );
      }
    });
    void loadBuddy();
    const timer = window.setInterval(loadBuddy, 10000);
    return () => {
      cancelled = true;
      generation++;
      window.clearInterval(timer);
      unsubscribe();
      unsubscribeData();
    };
  }, []);
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
        const data = await getSessionJson("/api/me", {
          signal,
          fresh: true,
          serverRefresh: "live",
        });
        if (!signal.aborted) {
          setProfile(normalizePlayerProfile(data));
          setRestoring(false);
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
    setError("");
    setConnectionOpen(false);
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
  const connect = (restoreRequestId) => {
    restoreRequestRef.current = restoreRequestId || null;
    setError("");
    setOpen(false);
    setConnectionOpen(true);
    telegramRef.current.connect(restoreRequestId).catch((error) => {
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
          <>
            <Button
              variant="primary"
              size="md"
              onClick={() => {
                setError("");
                if (!TELEGRAM_CONNECTOR_ORIGIN) {
                  setError(
                    "Откройте Wiki через Telegram для подключения игрового аккаунта.",
                  );
                  return;
                }
                setOpen(true);
              }}
            >
              {pendingLogin ? "Продолжить вход" : "Войти"}
            </Button>
            {hasTelegramInitData && (
              <Button
                variant="secondary"
                size="md"
                onClick={() => setDeviceManagerOpen(true)}
              >
                Устройства
              </Button>
            )}
          </>
        )}
        {open && authenticated && (
          <BaseCard
            variant="popover"
            className="profile-session"
            id="profile-session"
            role="region"
            aria-label="Сеанс пользователя"
          >
            {buddyCount > 0 && (
              <>
                <CardTitle size="xs">Buddy активен · {buddyCount}</CardTitle>
                <Button
                  variant="secondary"
                  onClick={() => {
                    window.location.hash = "friends";
                    setOpen(false);
                  }}
                >
                  Открыть друзей
                </Button>
              </>
            )}
            <CardTitle size="xs">Автопрокачка</CardTitle>
            <CardDescription size="xs">
              {floor.status === "running"
                ? floor.target
                  ? `Цель: ${floor.target.destination} · ${floor.target.kind === "work" ? "работа" : floor.target.kind === "boss" ? "босс" : "бизнес"}`
                  : "Ищем следующую цель"
                : floor.status === "paused"
                  ? "Приостановлена"
                  : "Остановлена"}
            </CardDescription>
            <CardDescription size="xs">
              Ожидание энергии, рейды и собственные бои, улучшение бизнеса.
            </CardDescription>
            {floor.reason && (
              <CardDescription size="xs">{floor.reason}</CardDescription>
            )}
            {floor.error && (
              <CardDescription size="xs" role="alert">
                {floor.error}
              </CardDescription>
            )}
            <Button
              variant="secondary"
              disabled={
                !floor.loaded || (floor.pending && floor.status !== "running")
              }
              onClick={() =>
                void (floor.status === "running" || floor.phase === "launching"
                  ? floorAutomation.stop()
                  : floorAutomation.start())
              }
            >
              {floor.status === "running" || floor.phase === "launching"
                ? "Остановить"
                : "Запустить"}
            </Button>
            <CardDescription className="profile-session-expiry">
              {label.split(" • ").map((line) => (
                <span key={line}>{line}</span>
              ))}
            </CardDescription>
            <ErrorToast message={error} />
            {hasTelegramInitData && (
              <Button
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  setDeviceManagerOpen(true);
                }}
              >
                Устройства
              </Button>
            )}
            <Button variant="secondary" onClick={logout}>
              Выйти
            </Button>
          </BaseCard>
        )}
      </div>
      {!authenticated && !connectionOpen && <ErrorToast message={error} />}
      {TELEGRAM_CONNECTOR_ORIGIN && (
        <TelegramConnection
          ref={telegramRef}
          open={connectionOpen}
          error={error}
          autoConnect={autoConnect}
          onRetry={() => connect(restoreRequestRef.current)}
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
            setError("");
            setOpen(true);
          }}
          onServerManagedSession={() => {
            saveServerManagedSession(telegramContext().userId);
            try {
              window.localStorage.setItem(
                accountStorageKey(AUTO_CONNECT_KEY),
                telegramContext().userId
                  ? "telegram:" + telegramContext().userId
                  : "1",
              );
            } catch {
              /* Session identity stays in memory when storage is unavailable. */
            }
            setAutoConnect(true);
            setPendingLogin(false);
            setSession(readSession());
            close();
          }}
        />
      )}
      <DeviceManagerDialog
        open={deviceManagerOpen}
        onClose={() => setDeviceManagerOpen(false)}
        onRestoreConnect={
          TELEGRAM_CONNECTOR_ORIGIN
            ? (requestId) => {
                setDeviceManagerOpen(false);
                connect(requestId);
              }
            : undefined
        }
      />
      {open && !authenticated && TELEGRAM_CONNECTOR_ORIGIN && (
        <Modal
          title="Вход в Madhouse Wiki"
          titleId="login-title"
          width={420}
          contentVariant="inset"
          onClose={close}
        >
          <div className="login-modal-actions">
            <Button
              variant="primary"
              liftOnHover={false}
              onClick={() => connect()}
            >
              {pendingLogin ? "Продолжить вход" : "Войти через Telegram"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
