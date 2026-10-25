import { memo } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { ImageCard } from "../../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { BossPortrait } from "../BossPortrait/BossPortrait.jsx";
import { canAttackBattle, battleActionHint } from "./boss-battle-controller.js";
import { medicineNames } from "./boss-medicines.js";
import { fmt } from "../../../lib/format.js";
import {
  formatBattleCountdown,
  bossExecutionStatus,
  sameBattleEvent,
  sameBattleEvents,
} from "./boss-battle-presentation.js";
import "./BossBattlePanel.css";

const formatHealth = (amount) =>
  amount >= 1_000_000
    ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(amount / 1_000_000)} млн`
    : fmt(amount);

function Health({ label, value, max, animationKey, remainingDamage = 0 }) {
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
          highlightAmount={remainingDamage}
          valueText={
            remainingDamage > 0
              ? `${text}. До нормы урона: ${fmt(remainingDamage)}`
              : text
          }
        />
      )}
    </div>
  );
}

export function battleEventText(event) {
  const actor = event.actor || "Участник";
  if (event.kind === "invite")
    return `${actor} · Пригласил друзей: ${fmt(event.invitedCount ?? 0)}`;
  if (event.kind === "join")
    return `${actor} · ${event.invitedBySelf ? "Вступил по вашему приглашению" : "Вступил в бой"}`;
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
  departmentCode,
  onAttack,
  auto = { enabled: false, nextAttackAt: null, pause: false },
}) {
  const { boss, battle } = state;
  const execution = bossExecutionStatus(state, auto);
  const automationRunning = Boolean(
    auto.enabled ||
    (state.raid?.enabled &&
      (state.raid.bossId == null ||
        Number(state.raid.bossId) === Number(boss.id))),
  );
  const reference = boss.reference || {};
  const businessItem = reference.possibleDrops?.find(
    (item) => item.type === "activity_item",
  );
  const businessItemId = businessItem?.itemId ?? businessItem?.entityId;
  const inventory = state.businessInventory;
  const businessStock =
    businessItemId != null && inventory
      ? (inventory.stock?.[businessItemId] ?? (inventory.complete ? 0 : null))
      : null;
  const waiting = battle
    ? Math.max(0, Math.ceil((battle.readyAt - now) / 1000))
    : 0;
  const expired = battle?.expiresAt != null && battle.expiresAt <= now;
  const hint = battleActionHint(state);
  const countdown =
    battle?.status === "active" && !battle.outcome
      ? formatBattleCountdown(battle.expiresAt, now)
      : null;
  return (
    <BaseCard className="boss-battle-panel">
      <div
        className={`boss-battle-panel-heading${execution || businessItem ? " boss-battle-panel-heading--with-item" : ""}`}
      >
        <BossPortrait src={reference.image} alt={boss.name} />
        <div className="boss-battle-panel-copy">
          <div className="boss-battle-panel-row">
            <CardTitle
              as="h3"
              size="md"
              title={[departmentCode, boss.name].filter(Boolean).join(" • ")}
            >
              {[departmentCode, boss.name].filter(Boolean).join(" • ")}
            </CardTitle>
          </div>
          <div className="boss-battle-panel-rewards">
            {reference.requiredLevel != null && (
              <CardDescription size="2xs">
                Уровень {fmt(reference.requiredLevel)}
                {reference.rewardUntilLevel != null
                  ? `–${fmt(reference.rewardUntilLevel)}`
                  : "+"}
              </CardDescription>
            )}
            {[
              ["gold", "coin", "Монеты"],
              ["pills", "pill", "Пилюли"],
              ["dollar", "banknote", "Купюры"],
            ]
              .filter(([key]) => reference.rewardPreview?.[key] != null)
              .map(([key, icon, label], index) => (
                <CardDescription
                  size="2xs"
                  key={key}
                  className="boss-battle-panel-reward"
                  title={`${label}: ${fmt(reference.rewardPreview[key])}`}
                >
                  {(reference.requiredLevel != null || index > 0) && (
                    <span>·</span>
                  )}
                  <Icon type={icon} size="small" />
                  {fmt(reference.rewardPreview[key])}
                </CardDescription>
              ))}
          </div>
          {!automationRunning &&
            ((!battle && reference.maxHp != null) ||
              (reference.damageMin != null && reference.damageMax != null)) && (
              <CardDescription size="2xs">
                {[
                  !battle && reference.maxHp != null
                    ? `Здоровье ${formatHealth(reference.maxHp)}`
                    : null,
                  reference.damageMin != null && reference.damageMax != null
                    ? `Урон ${fmt(reference.damageMin)}–${fmt(reference.damageMax)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </CardDescription>
            )}
          {automationRunning && businessItem && (
            <div className="boss-battle-panel-reward">
              <ImageCard
                src={businessItem.image}
                alt=""
                size={24}
                imageSize={16}
              />
              <CardDescription size="2xs">
                {businessItem.name || "Предмет бизнеса"}
              </CardDescription>
            </div>
          )}
        </div>
        {execution ? (
          <Pill
            variant={execution.variant}
            size="xs"
            dot={battle?.status === "active"}
            role="status"
            motion={
              execution.label === "Ждём приглашения" ? "pulse" : undefined
            }
          >
            {execution.variant === "scheduled" &&
              execution.label !== "Ждём приглашения" && (
                <Icon type="loader" size="small" motion="spin" />
              )}
            {battle?.status === "active" ? (
              <>Идёт{countdown !== null && ` · ${countdown}`}</>
            ) : (
              execution.label
            )}
          </Pill>
        ) : (
          businessItem && (
            <div className="boss-battle-panel-item">
              <ImageCard
                src={businessItem.image}
                alt={businessItem.name || "Предмет бизнеса"}
                title={businessItem.name || "Предмет бизнеса"}
                size={48}
              />
              <CardDescription
                size="2xs"
                title="В инвентаре"
                aria-label={`В инвентаре: ${businessStock ?? "нет данных"}`}
              >
                {businessStock != null ? fmt(businessStock) : "—"}
              </CardDescription>
            </div>
          )
        )}
      </div>
      {automationRunning &&
        battle?.status === "active" &&
        !battle.outcome &&
        state.healing?.invitation && (
          <div className="boss-battle-panel-row">
            <CardDescription
              size="xs"
              title={state.healing.invitationNotice || undefined}
            >
              <Icon type="group" size="small" />{" "}
              {state.healing.invitation.attempted
                ? `Приглашено друзей: ${fmt(state.healing.invitation.invitedCount)}`
                : "Приглашаем друзей"}
            </CardDescription>
            <CardDescription size="xs">
              {state.healing.invitation.blocked
                ? "Рассылка недоступна"
                : state.healing.invitation.nextAt != null
                  ? `Через ${formatBattleCountdown(state.healing.invitation.nextAt, now)}`
                  : "—"}
            </CardDescription>
          </div>
        )}
      {battle && !battle.outcome && (
        <>
          <Health
            label="Босс"
            remainingDamage={
              Number.isFinite(battle.dropDamageRequired) &&
              Number.isFinite(battle.totalDamage)
                ? Math.max(0, battle.dropDamageRequired - battle.totalDamage)
                : 0
            }
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
      {battle && !battle.outcome && !automationRunning ? (
        <div className="boss-battle-panel-controls">
          <Button
            variant="primary"
            icon="combat"
            disabled={auto.enabled || !canAttackBattle(state, now)}
            title={auto.enabled ? "Ручной удар недоступен в авторежиме" : hint}
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
        </div>
      ) : null}
      {state.notice && !state.medicineOpen && (
        <CardDescription role="status" title={state.notice}>
          {state.notice}
        </CardDescription>
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
}) {
  const count =
    participantCount != null
      ? `${fmt(participantCount)}${maxParticipants != null ? ` / ${fmt(maxParticipants)}` : ""}`
      : undefined;
  return (
    <Disclosure
      size="sm"
      title="Участники"
      leading={<Icon type="group" size="medium" />}
      status={
        <CardDescription size="xs">{count ?? "Нет данных"}</CardDescription>
      }
      countLabel={count ? `Участников: ${count}` : undefined}
    >
      {participants.length ? (
        <div className="boss-battle-journal-viewport">
          <div
            className="boss-battle-journal-records"
            role="list"
            aria-label="Участники боя"
          >
            {participants.map((participant, index) => (
              <div
                className="boss-battle-participant-row"
                role="listitem"
                key={index}
              >
                <Icon type="character" size="small" />
                <CardDescription title={participant.nickname}>
                  {participant.nickname || `Участник ${index + 1}`}
                </CardDescription>
                <CardTitle as="span" size="sm" title="Урон по боссу">
                  {participant.damageDealt != null
                    ? fmt(participant.damageDealt)
                    : "—"}
                </CardTitle>
              </div>
            ))}
          </div>
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
    const action =
      event.kind === "invite"
        ? "Пригласил друзей"
        : event.kind === "join"
          ? event.invitedBySelf
            ? "Вступил по вашему приглашению"
            : "Вступил в бой"
          : event.itemType
            ? medicineNames[event.itemType] || "Боевой предмет"
            : event.damage != null
              ? event.critical
                ? "Критический удар"
                : "Удар"
              : `Ход ${fmt(event.turn)}`;
    const amount =
      event.kind === "invite"
        ? fmt(event.invitedCount ?? 0)
        : event.itemType
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
          {event.isSelf ? (
            <strong>
              {actor} · {action}
            </strong>
          ) : (
            `${actor} · ${action}`
          )}
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
        size="sm"
        defaultOpen
        title="Журнал боя"
        leading={<Icon type="book" size="medium" />}
        status={
          <CardDescription size="xs">{fmt(events.length)}</CardDescription>
        }
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
  const combinedEvents = new Map();
  for (const event of [
    ...(battle.localEvents ?? []),
    ...(battle.events ?? []),
    ...(battle.joinEvents ?? []),
  ])
    combinedEvents.set(event.localKey ?? `turn:${event.turn}`, event);
  const events = [...combinedEvents.values()]
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || (b.turn ?? 0) - (a.turn ?? 0))
    .slice(0, 200);
  return (
    <>
      <BattleParticipants
        participants={battle.participants || EMPTY_LIST}
        participantCount={battle.participantCount}
        maxParticipants={boss.reference?.maxParticipants}
      />
      <BattleJournal events={events} />
    </>
  );
}
