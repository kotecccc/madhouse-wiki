import { memo } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { BossPortrait } from "../BossPortrait/BossPortrait.jsx";
import { canAttackBattle, battleActionHint } from "./boss-battle-controller.js";
import { medicineNames } from "./boss-medicines.js";
import { fmt } from "../../../lib/format.js";
import {
  formatBattleCountdown,
  sameBattleEvent,
  sameBattleEvents,
} from "./boss-battle-presentation.js";
import "./BossBattlePanel.css";

const formatHealth = (amount) =>
  amount >= 1_000_000
    ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(amount / 1_000_000)} млн`
    : fmt(amount);

function Health({ label, value, max, animationKey }) {
  const known = Number.isFinite(value) && Number.isFinite(max) && max > 0;
  const text = known
    ? `${formatHealth(value)} / ${formatHealth(max)}`
    : "Нет данных";
  return (
    <div className="boss-battle-panel-stack">
      <div className="boss-battle-panel-row">
        <CardDescription>{label}</CardDescription>
        <CardTitle title={text}>{text}</CardTitle>
      </div>
      {known && (
        <ProgressBar
          animateLoss
          animationKey={animationKey}
          label={`Здоровье: ${label}`}
          value={value}
          max={max}
          valueText={text}
        />
      )}
    </div>
  );
}

export function battleEventText(event) {
  const actor = event.actor || "Участник";
  if (event.itemType) {
    const medicine = medicineNames[event.itemType] || "Боевой предмет";
    return `${actor} · ${medicine}${event.healthRestored != null ? ` · +${fmt(event.healthRestored)} HP` : ""}`;
  }
  if (event.confirmed && event.damage == null)
    return `${actor} · Удар подтверждён`;
  if (event.damage != null)
    return `${actor} · ${event.critical ? "Критический удар" : "Удар"} · ${fmt(event.damage)} урона`;
  return `${actor} · Ход ${fmt(event.turn)}`;
}

export function BossBattlePanel({
  state,
  now,
  onStart,
  startBlocked = false,
  departmentCode,
  onAttack,
  onMedicines,
  auto = { enabled: false, nextAttackAt: null, pause: false },
}) {
  const { boss, battle } = state;
  const reference = boss.reference || {};
  const waiting = battle
    ? Math.max(0, Math.ceil((battle.readyAt - now) / 1000))
    : 0;
  const expired = battle?.expiresAt != null && battle.expiresAt <= now;
  const stockKnown =
    Array.isArray(state.medicines) &&
    state.medicines.length > 0 &&
    state.medicines.every((m) => Number.isFinite(m.quantity));
  const stock = stockKnown
    ? state.medicines.reduce((sum, m) => sum + m.quantity, 0)
    : null;
  const hint = battleActionHint(state);
  const countdown =
    battle?.status === "active" && !battle.outcome
      ? formatBattleCountdown(battle.expiresAt, now)
      : null;
  return (
    <BaseCard className="boss-battle-panel">
      <div className="boss-battle-panel-heading">
        <BossPortrait src={reference.image} alt={boss.name} />
        <div className="boss-battle-panel-copy">
          <div className="boss-battle-panel-row">
            <CardTitle
              as="h3"
              size="lg"
              title={[departmentCode, boss.name].filter(Boolean).join(" • ")}
            >
              {[departmentCode, boss.name].filter(Boolean).join(" • ")}
            </CardTitle>
          </div>
          {(reference.requiredLevel != null ||
            (reference.damageMin != null && reference.damageMax != null)) && (
            <CardDescription size="xs">
              {[
                reference.requiredLevel != null
                  ? `Уровень ${fmt(reference.requiredLevel)}${reference.rewardUntilLevel != null ? `–${fmt(reference.rewardUntilLevel)}` : "+"}`
                  : null,
                reference.damageMin != null && reference.damageMax != null
                  ? `Урон ${fmt(reference.damageMin)}–${fmt(reference.damageMax)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </CardDescription>
          )}
          {!battle && reference.maxHp != null && (
            <CardDescription size="xs">
              Здоровье {formatHealth(reference.maxHp)}
            </CardDescription>
          )}
          <div className="boss-battle-panel-rewards">
            {[
              ["gold", "coin", "Монеты"],
              ["pills", "pill", "Пилюли"],
              ["dollar", "banknote", "Купюры"],
            ].map(
              ([key, icon, label]) =>
                reference.rewardPreview?.[key] != null && (
                  <CardDescription
                    size="xs"
                    key={key}
                    className="boss-battle-panel-reward"
                    title={`${label}: ${fmt(reference.rewardPreview[key])}`}
                  >
                    <Icon type={icon} size="small" />
                    {fmt(reference.rewardPreview[key])}
                  </CardDescription>
                ),
            )}
          </div>
        </div>
      </div>
      {countdown !== null && (
        <CardDescription size="xs">
          До окончания боя: {countdown}
        </CardDescription>
      )}
      {battle && (
        <>
          <Health
            label="Босс"
            animationKey={battle.id}
            value={battle.bossHealth}
            max={battle.bossMaxHealth}
          />
          <Health
            label="Вы"
            animationKey={battle.id}
            value={battle.playerHealth}
            max={battle.playerMaxHealth}
          />
        </>
      )}
      {battle &&
        Number.isFinite(battle.dropDamageRequired) &&
        battle.dropDamageRequired > 0 &&
        Number.isFinite(battle.totalDamage) && (
          <div className="boss-battle-panel-stack">
            {battle.quotaFresh !== true && (
              <CardDescription>
                Последнее подтверждённое значение нормы. Для приглашения сервер
                перепроверит бой.
              </CardDescription>
            )}
            <div className="boss-battle-panel-row">
              <CardDescription>Норма урона</CardDescription>
              <CardTitle>
                {fmt(battle.totalDamage)} / {fmt(battle.dropDamageRequired)}
              </CardTitle>
            </div>
            <ProgressBar
              label="Прогресс нормы урона"
              value={battle.totalDamage}
              max={battle.dropDamageRequired}
              valueText={`${fmt(battle.totalDamage)} из ${fmt(battle.dropDamageRequired)}`}
            />
            <CardDescription>
              Осталось нанести:{" "}
              {fmt(Math.max(0, battle.dropDamageRequired - battle.totalDamage))}
              . Выполнение нормы не гарантирует выпадение предмета.
            </CardDescription>
          </div>
        )}
      {battle?.status === "active" &&
        (battle.dropDamageRequired == null || battle.totalDamage == null) && (
          <CardDescription>
            Норма урона пока неизвестна. Приглашения отложены.
          </CardDescription>
        )}
      {battle?.dropDamageRequired === 0 && battle.quotaFresh && (
        <CardDescription>
          Сервер не требует минимального урона в этом бою.
        </CardDescription>
      )}
      {battle?.outcome ? (
        <div className="boss-battle-panel-stack" role="status">
          <CardTitle>Результат: {battle.outcome}</CardTitle>
        </div>
      ) : (
        <div className="boss-battle-panel-controls">
          {battle?.status === "active" && (
            <Button
              icon="pill"
              disabled={Boolean(state.pending)}
              onClick={onMedicines}
              aria-expanded={state.medicineOpen}
            >
              {state.medicineOpen
                ? "Скрыть аптечки"
                : `Аптечки${stock !== null ? ` · ${fmt(stock)}` : ""}`}
            </Button>
          )}
          {battle ? (
            <Button
              variant="primary"
              icon="combat"
              disabled={auto.enabled || !canAttackBattle(state, now)}
              title={
                auto.enabled ? "Ручной удар недоступен в авторежиме" : hint
              }
              onClick={onAttack}
            >
              {auto.enabled
                ? "Ударить"
                : state.pending === "attack"
                  ? "Удар…"
                  : waiting > 0
                    ? `Ударить · ${waiting} с`
                    : "Ударить"}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="combat"
              disabled={
                startBlocked ||
                auto.enabled ||
                Boolean(state.pending) ||
                state.needsRefresh ||
                !state.canStart
              }
              title={hint}
              onClick={onStart}
            >
              {["start", "restart"].includes(state.pending)
                ? "Запуск…"
                : "Начать бой"}
            </Button>
          )}
        </div>
      )}
      {state.notice && !state.medicineOpen && (
        <CardDescription role="status" title={state.notice}>
          {state.notice}
        </CardDescription>
      )}
      {battle?.outcome && (state.medicineOpen || state.purchaseUncertain) && (
        <Button
          icon="pill"
          disabled={Boolean(state.pending)}
          onClick={onMedicines}
          aria-expanded={state.medicineOpen}
        >
          Аптечки
        </Button>
      )}
      {expired && !battle.outcome && (
        <CardDescription>
          Время боя истекло. Обновите результат.
        </CardDescription>
      )}
      {battle?.playerHealth === 0 && !battle.outcome && (
        <CardDescription>
          Здоровье закончилось. Обновите результат боя.
        </CardDescription>
      )}
    </BaseCard>
  );
}

const EMPTY_LIST = [];

const BattleParticipants = memo(function BattleParticipants({
  participants,
  participantCount,
  maxParticipants,
  stale,
}) {
  const count =
    participantCount != null
      ? `${fmt(participantCount)}${maxParticipants != null ? ` / ${fmt(maxParticipants)}` : ""}`
      : undefined;
  return (
    <Disclosure
      title="Участники"
      count={count}
      countLabel={count ? `Участников: ${count}` : undefined}
      description={count ? undefined : "Нет данных"}
    >
      {stale && (
        <CardDescription>
          Список участников сохранён до последнего действия. Обновите бой, чтобы
          получить актуальный урон.
        </CardDescription>
      )}
      {participants.length ? (
        <div className="boss-battle-panel-stack">
          {participants.map((participant, index) => (
            <BaseCard
              key={index}
              padding="12"
              className="boss-battle-panel-stack"
            >
              <div className="boss-battle-panel-row">
                <CardTitle title={participant.nickname}>
                  {participant.nickname || `Участник ${index + 1}`}
                </CardTitle>
                {participant.damageDealt != null && (
                  <CardDescription title="Урон по боссу">
                    {fmt(participant.damageDealt)} урона
                  </CardDescription>
                )}
              </div>
              {participant.level != null && (
                <CardDescription size="xs">
                  Уровень {fmt(participant.level)}
                </CardDescription>
              )}
            </BaseCard>
          ))}
        </div>
      ) : (
        <CardDescription>Сервер не передал список участников.</CardDescription>
      )}
    </Disclosure>
  );
});

const BattleJournalEvent = memo(
  function BattleJournalEvent({ event }) {
    const actor = event.actor || "Участник";
    const action = event.itemType
      ? medicineNames[event.itemType] || "Боевой предмет"
      : event.damage != null
        ? event.critical
          ? "Критический удар"
          : "Удар"
        : `Ход ${fmt(event.turn)}`;
    const amount = event.itemType
      ? event.healthRestored != null
        ? `+${fmt(event.healthRestored)} HP`
        : "—"
      : event.damage != null
        ? fmt(event.damage)
        : "—";
    return (
      <div className="boss-battle-panel-event">
        <CardDescription size="xs">
          {event.at != null
            ? new Date(event.at).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })
            : `Ход ${fmt(event.turn)}`}
        </CardDescription>
        <CardDescription title={battleEventText(event)}>
          {actor} · {action}
        </CardDescription>
        <CardTitle as="span" size="sm" title={battleEventText(event)}>
          {amount}
        </CardTitle>
      </div>
    );
  },
  (previous, next) => sameBattleEvent(previous.event, next.event),
);

const BattleJournal = memo(
  function BattleJournal({ events }) {
    return (
      <Disclosure
        defaultOpen
        title="Журнал боя"
        count={fmt(events.length)}
        countLabel={`Событий в ответе: ${events.length}`}
      >
        <div className="boss-battle-journal-viewport">
          <div
            className="boss-battle-journal-records"
            role="log"
            aria-label="События боя"
            aria-live="off"
            tabIndex={0}
          >
            {events.length ? (
              events.map((event) => (
                <BattleJournalEvent
                  key={
                    event.localKey ??
                    `${event.turn}-${event.actor}-${event.at ?? "unknown"}`
                  }
                  event={event}
                />
              ))
            ) : (
              <CardDescription>Сервер не передал события боя.</CardDescription>
            )}
          </div>
        </div>
      </Disclosure>
    );
  },
  (previous, next) => sameBattleEvents(previous.events, next.events),
);

export function BossBattleDetails({ boss, battle }) {
  if (!battle) return null;
  return (
    <>
      <BattleParticipants
        stale={battle.participantsStale}
        participants={battle.participants || EMPTY_LIST}
        participantCount={battle.participantCount}
        maxParticipants={boss.reference?.maxParticipants}
      />
      <BattleJournal events={battle.events || EMPTY_LIST} />
    </>
  );
}
