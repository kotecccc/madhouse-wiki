import {
  readRetryStartedAt,
  writeRetryStartedAt,
  retrySeconds,
} from "../../../../shared/retry-countdown.js";
import { safeFailedFeatures } from "../../../../shared/game-health-features.js";
import { StatusList } from "../../ui/StatusList/StatusList.jsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getSessionJson,
  readGameHealth,
  readSessionRefreshState,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Icon } from "../../ui/Icon/Icon.jsx";
import { Modal } from "../../ui/Modal/Modal.jsx";
import { CardDescription } from "../../ui/CardDescription/CardDescription.jsx";
import { StatusMessage } from "../../ui/StatusMessage/StatusMessage.jsx";
import "./GameHealthWarning.css";

const HEALTH_RETRY_KEY = "madhouse:game-health-refresh-started-at:v1";
let bannerDismissed = false;
const bannerDismissedListeners = new Set();

function subscribeBannerDismissed(listener) {
  bannerDismissedListeners.add(listener);
  return () => bannerDismissedListeners.delete(listener);
}

function readBannerDismissed() {
  return bannerDismissed;
}

function dismissBanner() {
  bannerDismissed = true;
  for (const listener of bannerDismissedListeners) listener();
}

const failedFeatureLabels = {
  profile: "Профиль",
  inventory: "Инвентарь",
  floors: "Этажи",
  rooms: "Комнаты",
  clothing: "Гардероб",
  weapons: "Оружие",
  pets: "Питомцы",
  ornaments: "Татуировки",
  businesses: "Бизнесы",
  bosses: "Боссы",
  game: "Игровые данные",
};

function healthMessage(status) {
  switch (status) {
    case "unavailable":
      return {
        label: "Игра отвечает с ошибками",
        description:
          "При обращении к игровому серверу возникли ошибки. Ниже показано последнее известное состояние функций.",
        detailTitle: "Игровые функции на паузе",
        detail:
          "Профиль, доступность этажей, запасы и другие личные данные могут быть устаревшими. Они требуют успешного ответа игры.",
      };
    case "credentials_invalid":
      return {
        label: "Требуется повторный вход",
        description:
          "Сохранённые данные входа больше не принимаются игрой. Войдите в игровой аккаунт снова, чтобы продолжить обновление личных данных.",
        detailTitle: "Нужно обновить доступ",
        detail:
          "Закройте это окно и откройте меню аккаунта, чтобы войти снова. Без действующего входа личные данные не обновляются.",
      };
    default:
      return {
        label: "Личный снимок ещё не получен",
        description:
          "Первый снимок личных игровых данных появится после успешного запроса к игре.",
        detailTitle: "Ждём игровые данные",
        detail:
          "Профиль, доступность этажей и запасы появятся после успешного ответа игрового сервера.",
      };
  }
}

export function formatLastSuccess(timestamp) {
  if (!Number.isFinite(timestamp)) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const fields = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${fields.hour}:${fields.minute} ${fields.day}.${fields.month}.${fields.year}`;
}

export function GameHealthDetails({ health }) {
  const message = healthMessage(health.status);
  const failed = safeFailedFeatures(health.failedFeatures);
  const successful = safeFailedFeatures(health.successfulFeatures);
  const items = Object.entries(failedFeatureLabels)
    .filter(([id]) => id !== "game" || failed.includes(id))
    .map(([id, label]) => ({
      id,
      label,
      status: failed.includes(id)
        ? "error"
        : successful.includes(id)
          ? "success"
          : "unknown",
    }));
  return (
    <>
      <StatusMessage
        icon={health.status === "credentials_invalid" ? "lock" : "warning"}
        tone="warning"
        title={message.label}
        description={message.description}
      />
      {health.status !== "credentials_invalid" && (
        <BaseCard className="ui-status-list-card">
          <StatusList items={items} />
        </BaseCard>
      )}
    </>
  );
}

export function healthRefreshLabel(seconds, checking) {
  if (seconds > 0)
    return `Обновить ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return checking ? "Проверяем…" : "Обновить";
}

function useGameHealthSnapshot() {
  const [health, setHealth] = useState(() => readGameHealth());
  useEffect(() => {
    const update = (event) => setHealth(event.detail || readGameHealth());
    window.addEventListener("madhouse:game-health", update);
    setHealth(readGameHealth());
    return () => window.removeEventListener("madhouse:game-health", update);
  }, []);
  return health;
}

function hasHealthWarning(health) {
  return health && !["available", "unknown"].includes(health.status);
}

export function GameHealthWarningIndicator() {
  const refreshing = useSyncExternalStore(
    subscribeSessionData,
    readSessionRefreshState,
    () => false,
  );
  const health = useGameHealthSnapshot();
  const bannerWasDismissed = useSyncExternalStore(
    subscribeBannerDismissed,
    readBannerDismissed,
    () => false,
  );
  const [open, setOpen] = useState(false);
  const [manualChecking, setManualChecking] = useState(false);
  const [initialRefreshAt] = useState(() =>
    readRetryStartedAt(HEALTH_RETRY_KEY),
  );
  const refreshUntil = useRef(initialRefreshAt + 60000);
  const [remainingSeconds, setRemainingSeconds] = useState(() =>
    retrySeconds(refreshUntil.current),
  );
  const refreshPending = useRef(false);
  useEffect(() => {
    if (!open) return;
    const updateCountdown = () =>
      setRemainingSeconds(Math.min(59, retrySeconds(refreshUntil.current)));
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [open]);
  const refreshHealth = async () => {
    if (refreshPending.current || Date.now() < refreshUntil.current) return;
    refreshPending.current = true;
    const startedAt = Date.now();
    refreshUntil.current = startedAt + 60000;
    writeRetryStartedAt(HEALTH_RETRY_KEY, startedAt);
    setRemainingSeconds(59);
    setManualChecking(true);
    try {
      await getSessionJson("/api/me", { fresh: true, serverRefresh: true });
    } catch {
      // Response metadata updates the shared health state; retain the last snapshot.
    } finally {
      refreshPending.current = false;
      setManualChecking(false);
    }
  };

  if (!hasHealthWarning(health)) return null;
  const message = healthMessage(health.status);
  const checking =
    manualChecking || (refreshing && health.status === "unavailable");
  const label = checking ? "Проверяем доступность игры" : message.label;

  return (
    <>
      <Button
        variant="icon-ghost"
        className={
          bannerWasDismissed
            ? undefined
            : "game-health-warning-indicator--banner-visible"
        }
        accent="gold"
        icon="warning"
        iconOnly
        aria-label={label}
        aria-busy={checking}
        title={label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Modal
          title={
            health.status === "unavailable" ? "Состояние игры" : message.label
          }
          loading={manualChecking}
          footerStart={
            <Button
              onClick={refreshHealth}
              disabled={manualChecking || remainingSeconds > 0}
              aria-busy={manualChecking}
            >
              {healthRefreshLabel(remainingSeconds, manualChecking)}
            </Button>
          }
          footerNote={
            <>
              Последнее обновление:
              <br />
              {formatLastSuccess(health.lastSuccessAt)}
            </>
          }
          contentAlignment="center"
          onClose={() => setOpen(false)}
        >
          <GameHealthDetails health={health} />
        </Modal>
      )}
    </>
  );
}

export function GameHealthWarningBanner() {
  const health = useGameHealthSnapshot();
  const dismissed = useSyncExternalStore(
    subscribeBannerDismissed,
    readBannerDismissed,
    () => false,
  );
  if (!hasHealthWarning(health) || dismissed) return null;

  const message = healthMessage(health.status);
  const label =
    health.status === "unavailable"
      ? "Наблюдаются сбои игровых серверов"
      : message.label;
  return (
    <BaseCard
      state="warning"
      padding="8"
      paddingInline="12"
      className="game-health-warning-banner"
    >
      <div className="game-health-warning-banner-copy">
        <Icon type="warning" size="small" motion="pulse" />
        <CardDescription size="sm">{label}</CardDescription>
      </div>
      <Button
        variant="icon-ghost"
        size="sm"
        accent="gold"
        icon="close"
        iconOnly
        aria-label="Закрыть предупреждение"
        title="Закрыть"
        onClick={dismissBanner}
      />
    </BaseCard>
  );
}
