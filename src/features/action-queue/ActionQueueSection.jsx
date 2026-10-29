import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { ProgressBar } from "../../components/ui/ProgressBar/ProgressBar.jsx";
import { Disclosure } from "../../components/ui/Disclosure/Disclosure.jsx";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { fmt } from "../../lib/format.js";
import { actionQueueCards } from "./action-queue-view.js";
import "./ActionQueueSection.css";

export function QueueActions({
  card,
  onCommand,
  onOpen,
  pending,
  moveIndex,
  moveCount,
}) {
  return (
    <div className="action-queue-actions">
      {card.movableSeries && (
        <>
          <Button
            size="sm"
            icon="arrow-up"
            iconOnly
            aria-label="Повысить приоритет"
            disabled={pending || moveIndex <= 0}
            onClick={() =>
              onCommand({ ...card, command: "queue.move", direction: "up" })
            }
          />
          <Button
            size="sm"
            icon="arrow-down"
            iconOnly
            aria-label="Понизить приоритет"
            disabled={pending || moveIndex >= moveCount - 1}
            onClick={() =>
              onCommand({ ...card, command: "queue.move", direction: "down" })
            }
          />
        </>
      )}
      {card.destination && (
        <Button
          className="action-queue-action"
          size="sm"
          icon="external-link"
          onClick={() => onOpen(card)}
        >
          Открыть
        </Button>
      )}
      {card.pauseCommand && (
        <Button
          size="sm"
          className="action-queue-action"
          icon={card.pauseCommand.endsWith(".resume") ? "play" : "pause"}
          disabled={pending}
          onClick={() => onCommand({ ...card, command: card.pauseCommand })}
        >
          {card.pauseCommand.endsWith(".resume") ? "Продолжить" : "Пауза"}
        </Button>
      )}
      {card.command && (
        <Button
          className="action-queue-action"
          size="sm"
          icon={card.actor ? "stop" : "x"}
          disabled={pending}
          onClick={() => onCommand(card)}
        >
          {card.actor ? "Остановить" : "Удалить"}
        </Button>
      )}
    </div>
  );
}

function SeriesStat({ icon, children }) {
  return (
    <Pill variant="unknown" dot={false}>
      <Icon type={icon} size="small" />
      {children}
    </Pill>
  );
}

export function BattleSeriesContent({ card }) {
  const { settings, goal } = card.series;
  const target = settings?.targetCount ?? settings?.target;
  const targetName =
    settings?.kind === "business_items"
      ? "Предметы для бизнеса"
      : settings?.kind === "drops"
        ? "Дроп"
        : settings?.kind === "battles"
          ? settings.countWins
            ? "Победы"
            : "Бои"
          : null;
  return (
    <>
      <CardTitle size="sm">Условия</CardTitle>
      <div className="action-queue-stats">
        {targetName && (
          <SeriesStat icon="target">
            {targetName}
            {Number.isFinite(target) ? ` · ${fmt(target)}` : ""}
          </SeriesStat>
        )}
        {settings && Object.hasOwn(settings, "durationHours") && (
          <SeriesStat icon="stopwatch">
            Длительность ·{" "}
            {settings.durationHours == null
              ? "Без ограничений"
              : `${fmt(settings.durationHours)} ч`}
          </SeriesStat>
        )}
        {Number.isFinite(settings?.maxAttempts) && (
          <SeriesStat icon="combat">
            Лимит попыток · {fmt(settings.maxAttempts)}
          </SeriesStat>
        )}
        {settings?.kind === "drops" && settings.selection === "all" && (
          <SeriesStat icon="loot">Все доступные предметы</SeriesStat>
        )}
        {settings?.items?.length > 0 && (
          <SeriesStat icon="loot">
            {settings.items
              .map((item) => item.name)
              .filter(Boolean)
              .join(", ")}
          </SeriesStat>
        )}
      </div>
      {!settings && <CardDescription>Условия пока недоступны.</CardDescription>}
      <CardTitle size="sm">Результаты</CardTitle>
      {goal ? (
        <>
          <div className="action-queue-stats">
            {Number.isFinite(goal.completedBattles) && (
              <SeriesStat icon="combat">
                Завершено боёв · {fmt(goal.completedBattles)}
              </SeriesStat>
            )}
            {Number.isFinite(goal.wins) && (
              <SeriesStat icon="check">Победы · {fmt(goal.wins)}</SeriesStat>
            )}
            {Number.isFinite(goal.losses) && (
              <SeriesStat icon="boss">
                Поражения · {fmt(goal.losses)}
              </SeriesStat>
            )}
            {goal.items
              ?.filter((item) => item.name && Number.isFinite(item.amount))
              .map((item) => (
                <SeriesStat key={item.key} icon="loot">
                  {item.name} · {fmt(item.amount)}
                </SeriesStat>
              ))}
          </div>
          {Number.isFinite(goal.progress) &&
            Number.isFinite(goal.target) &&
            goal.target > 0 && (
              <div className="action-queue-goal-progress">
                <CardDescription>
                  Прогресс цели · {fmt(goal.progress)} / {fmt(goal.target)}
                </CardDescription>
                <ProgressBar
                  value={goal.progress}
                  max={goal.target}
                  label="Прогресс цели"
                  valueText={`${fmt(goal.progress)} из ${fmt(goal.target)}`}
                />
              </div>
            )}
          {goal.rewardUncertain && (
            <CardDescription>Награды ещё проверяются.</CardDescription>
          )}
        </>
      ) : (
        <CardDescription>
          {card.actor ? "Результаты пока недоступны." : "Ещё нет результатов."}
        </CardDescription>
      )}
      {card.cancelNotice && (
        <CardDescription>{card.cancelNotice}</CardDescription>
      )}
      {card.reconciliationNotice && (
        <CardDescription>{card.reconciliationNotice}</CardDescription>
      )}
      {card.position && (
        <CardDescription>В очереди: {card.position}</CardDescription>
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
    </>
  );
}

export function ActionQueueSection({
  authenticated,
  state,
  presence = "unknown",
  catalogue,
  onCommand,
  onOpen,
  pending,
}) {
  const cards = actionQueueCards(state, catalogue);
  const movable = (state?.queuedActions ?? [])
    .filter(
      (job) =>
        ["auto.start", "raid.start"].includes(job.type) &&
        ["queued", "waiting"].includes(job.status) &&
        !job.cancelRequested,
    )
    .sort(
      (a, b) =>
        (a.queueOrderAt ?? a.createdAt) - (b.queueOrderAt ?? b.createdAt) ||
        a.createdAt - b.createdAt,
    );
  return (
    <section className="action-queue-section">
      <Disclosure
        separated
        title="Что такое очередь действий?"
        leading={<Icon type="info" size="medium" />}
      >
        <CardDescription>
          Здесь показаны выполняемые и ожидающие действия. Очередь автоматически
          запускает готовые задачи с учётом их приоритета и условий.
        </CardDescription>
        <CardDescription>
          Автобой или рейд с другим боссом ждёт завершения текущего боя и других
          мешающих действий. Если игра временно недоступна, задача останется в
          ожидании до следующей попытки.
        </CardDescription>
        <CardDescription>
          Откройте карточку, чтобы посмотреть детали и управлять задачей.
        </CardDescription>
      </Disclosure>
      {!authenticated ? (
        <CardDescription>Войдите, чтобы увидеть свои действия.</CardDescription>
      ) : presence === "missing" ? (
        <CardDescription>
          Сохранённого состояния очереди пока нет.
        </CardDescription>
      ) : presence === "unavailable" ? (
        <CardDescription>
          Не удалось прочитать сохранённое состояние очереди. Повторная проверка
          будет выполнена автоматически.
        </CardDescription>
      ) : !state ? (
        <div
          className="action-queue-list"
          role="status"
          aria-label="Загрузка очереди"
        >
          <Skeleton />
          <Skeleton />
        </div>
      ) : !cards.length ? (
        <CardDescription>Запланированных действий нет.</CardDescription>
      ) : (
        <div className="action-queue-list">
          {cards.map((card) =>
            card.series ? (
              <Disclosure
                key={card.id}
                separated
                title={card.title}
                description={`${card.detail ? `${card.detail} · ` : ""}${card.status}`}
                leading={
                  card.image ? (
                    <ImageCard src={card.image} size={64} />
                  ) : undefined
                }
                footer={
                  <QueueActions
                    card={card}
                    onCommand={onCommand}
                    onOpen={onOpen}
                    pending={pending}
                    moveIndex={movable.findIndex((job) => job.id === card.id)}
                    moveCount={movable.length}
                  />
                }
              >
                <BattleSeriesContent card={card} />
              </Disclosure>
            ) : (
              <BaseCard key={card.id} className="action-queue-card">
                <div className="action-queue-row">
                  {card.image && <ImageCard src={card.image} size={64} />}
                  <div className="action-queue-copy">
                    <CardTitle>{card.title}</CardTitle>
                    <CardDescription>
                      {card.detail ? `${card.detail} · ` : ""}
                      {card.status}
                    </CardDescription>
                    {card.cancelNotice && (
                      <CardDescription>{card.cancelNotice}</CardDescription>
                    )}
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
                  <QueueActions
                    card={card}
                    onCommand={onCommand}
                    onOpen={onOpen}
                    pending={pending}
                  />
                </div>
                {card.progressLabel && (
                  <CardDescription>{card.progressLabel}</CardDescription>
                )}
                {card.progress && (
                  <ProgressBar
                    value={card.progress.value}
                    max={card.progress.max}
                    label={card.progressLabel || "Прогресс"}
                    valueText={`${card.progress.value} из ${card.progress.max}`}
                  />
                )}
              </BaseCard>
            ),
          )}
        </div>
      )}
    </section>
  );
}
