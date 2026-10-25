import { useEffect, useState } from "react";
import { readGameHealth } from "../../../../shared/session-api.js";
import { Button } from "../../ui/Button/Button.jsx";
import { CardDescription } from "../../ui/CardDescription/CardDescription.jsx";
import { Dialog } from "../../ui/Dialog/Dialog.jsx";
import { DialogCloseButton } from "../../ui/DialogCloseButton/DialogCloseButton.jsx";
import { Title } from "../../ui/Title/Title.jsx";
import "./GameHealthWarning.css";

function healthMessage(status) {
  switch (status) {
    case "unavailable":
      return {
        label: "Игровые данные временно недоступны",
        description:
          "Справочник Madhouse Wiki работает автономно. Личные игровые данные обновляются отдельными запросами и могут быть устаревшими, пока игра не отвечает. Игровые действия приостановлены. Сохранённые секции могут обновляться в разное время; время ниже — последнее обновление одной из секций, не всего аккаунта.",
      };
    case "credentials_invalid":
      return {
        label: "Требуется повторный вход",
        description:
          "Сохранённые данные входа больше не принимаются игрой. Войдите в игровой аккаунт снова, чтобы продолжить обновление личных данных.",
      };
    default:
      return {
        label: "Личный снимок ещё не получен",
        description:
          "Справочник Madhouse Wiki доступен автономно. Первый снимок личных игровых данных появится после успешного запроса к игре.",
      };
  }
}

function formatLastSuccess(timestamp) {
  if (!Number.isFinite(timestamp)) return "Успешных обновлений ещё не было.";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()))
    return "Время последнего обновления неизвестно.";
  return `Последнее успешное обновление: ${new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}.`;
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
      <Button
        variant="warning-icon"
        size="md"
        aria-label={message.label}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">!</span>
      </Button>
      <Dialog
        modal
        visible={open}
        onClose={() => setOpen(false)}
        aria-labelledby="game-health-title"
        aria-describedby="game-health-description"
        className="game-health-warning-dialog"
      >
        <div className="game-health-warning-heading">
          <Title as="h2" id="game-health-title">
            {message.label}
          </Title>
          <DialogCloseButton onClick={() => setOpen(false)} />
        </div>
        <CardDescription as="p" id="game-health-description" size="md">
          {message.description}
        </CardDescription>
        <CardDescription as="p" size="sm">
          {formatLastSuccess(health.lastSuccessAt)}
        </CardDescription>
        <CardDescription as="p" size="sm">
          Wiki использует локальный справочник независимо от доступности игры.
          Профиль, доступность этажей, запасы и другие личные данные требуют
          успешного чтения игрового API.
        </CardDescription>
      </Dialog>
    </>
  );
}
