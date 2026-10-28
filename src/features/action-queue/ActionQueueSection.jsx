import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { ContentSection } from "../../components/ui/ContentSection/ContentSection.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { ProgressBar } from "../../components/ui/ProgressBar/ProgressBar.jsx";
import { actionQueueCards } from "./action-queue-view.js";
import "./ActionQueueSection.css";

export function ActionQueueSection({
  authenticated,
  state,
  catalogue,
  onCommand,
  onOpen,
  pending,
}) {
  const cards = actionQueueCards(state, catalogue);
  return (
    <ContentSection>
      {!authenticated ? (
        <CardDescription>Войдите, чтобы увидеть свои действия.</CardDescription>
      ) : !state ? (
        <CardDescription>Загружаем очередь…</CardDescription>
      ) : !cards.length ? (
        <CardDescription>Запланированных действий нет.</CardDescription>
      ) : (
        <div className="action-queue-list">
          {cards.map((card) => (
            <BaseCard key={card.id} className="action-queue-card">
              <div className="action-queue-row">
                {card.image && <ImageCard src={card.image} size={64} />}
                <div className="action-queue-copy">
                  <CardTitle>{card.title}</CardTitle>
                  <CardDescription>
                    {card.detail ? `${card.detail} · ` : ""}
                    {card.status}
                  </CardDescription>
                  {card.position && (
                    <CardDescription>
                      В очереди: {card.position}
                    </CardDescription>
                  )}
                  {card.retryAt != null && (
                    <CardDescription>
                      {card.retryIsReconciliation
                        ? "Следующая проверка не раньше "
                        : "Следующая попытка не раньше "}
                      <time dateTime={new Date(card.retryAt).toISOString()}>
                        {new Intl.DateTimeFormat("ru-RU", {
                          dateStyle: "short",
                          timeStyle: "medium",
                        }).format(card.retryAt)}
                      </time>
                    </CardDescription>
                  )}
                </div>
                {card.destination && (
                  <Button size="sm" onClick={() => onOpen(card)}>
                    Открыть
                  </Button>
                )}
                {card.pauseCommand && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      onCommand({ ...card, command: card.pauseCommand })
                    }
                  >
                    {card.pauseCommand.endsWith(".resume")
                      ? "Продолжить"
                      : "Пауза"}
                  </Button>
                )}
                {card.command && (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => onCommand(card)}
                  >
                    {card.actor ? "Остановить" : "Удалить"}
                  </Button>
                )}
              </div>
              {card.progress && (
                <ProgressBar
                  value={card.progress.value}
                  max={card.progress.max}
                  label="Прогресс"
                  valueText={`${card.progress.value} из ${card.progress.max}`}
                />
              )}
            </BaseCard>
          ))}
        </div>
      )}
    </ContentSection>
  );
}
