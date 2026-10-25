import { useEffect, useState } from "react";
import { readGameHealth } from "../../../../shared/session-api.js";
import { BaseCard } from "../../ui/BaseCard/BaseCard.jsx";
import { Button } from "../../ui/Button/Button.jsx";
import { Icon } from "../../ui/Icon/Icon.jsx";
import { Modal } from "../../ui/Modal/Modal.jsx";
import { StatusMessage } from "../../ui/StatusMessage/StatusMessage.jsx";

function healthMessage(status) {
  switch (status) {
    case "unavailable":
      return {
        label: "Игра временно недоступна",
        description:
          "Игровой сервер не отвечает на запросы Wiki. Обновление личных данных и игровые действия приостановлены до восстановления связи.",
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
  return (
    <StatusMessage
      icon={health.status === "credentials_invalid" ? "lock" : "warning"}
      tone="warning"
      title={message.label}
      description={message.description}
    />
  );
}

export function GameHealthNotice({ health }) {
  const message = healthMessage(health.status);
  return (
    <BaseCard state="warning">
      <StatusMessage
        compact
        iconAlignment="center"
        tone="warning"
        icon={health.status === "credentials_invalid" ? "lock" : "timer"}
        title={message.detailTitle}
        description={message.detail}
      />
    </BaseCard>
  );
}

export function GameHealthWarning() {
  const [health, setHealth] = useState(() => readGameHealth());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = (event) => setHealth(event.detail || readGameHealth());
    window.addEventListener("madhouse:game-health", update);
    setHealth(readGameHealth());
    return () => window.removeEventListener("madhouse:game-health", update);
  }, []);

  if (!health || health.status === "available" || health.status === "unknown")
    return null;
  const message = healthMessage(health.status);

  return (
    <>
      <BaseCard
        variant="glass-nav"
        state="warning"
        className="game-health-warning"
      >
        <Button
          variant="nav-tab"
          size="md"
          accent="gold"
          aria-label={message.label}
          title={message.label}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Icon type="warning" size="large" />
        </Button>
      </BaseCard>
      {open && (
        <Modal
          title={
            health.status === "unavailable"
              ? "Сервера игры не отвечают"
              : message.label
          }
          footerNote={
            <>
              Последнее обновление:
              <br />
              {formatLastSuccess(health.lastSuccessAt)}
            </>
          }
          contentAlignment="center"
          contentBottom={<GameHealthNotice health={health} />}
          onClose={() => setOpen(false)}
        >
          <GameHealthDetails health={health} />
        </Modal>
      )}
    </>
  );
}
