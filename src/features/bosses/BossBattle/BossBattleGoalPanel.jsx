import { useId, useState } from "react";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { FieldLabel } from "../../../components/ui/FieldLabel/FieldLabel.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { canStartAutoSeries } from "./boss-battle-auto.js";
import {
  BOSS_GOAL_KINDS,
  goalDropOptions,
  defaultBattleSettings,
  battleSettingsConfig,
} from "./boss-goal-options.js";
import "./BossBattleGoalPanel.css";

function executionStatus(state, goal, auto, raid) {
  if (raid.enabled) {
    if (raid.status === "joining")
      return { label: "Вступление", variant: "scheduled" };
    if (auto.enabled)
      return auto.pause
        ? { label: "На паузе", variant: "warning" }
        : { label: "Рейд идёт", variant: "active" };
    return { label: "Ожидание боя", variant: "scheduled" };
  }
  if (auto.enabled)
    return auto.pause
      ? { label: "На паузе", variant: "warning" }
      : { label: "Автобой идёт", variant: "active" };
  if (state.pending) return { label: "Подготовка", variant: "scheduled" };
  if (
    raid.status === "paused" ||
    state.needsRefresh ||
    state.error ||
    state.purchaseUncertain
  )
    return { label: "На паузе", variant: "warning" };
  if (goal?.status === "completed")
    return { label: "Выполнено", variant: "completed" };
  if (["expired", "exhausted"].includes(goal?.status))
    return { label: "Завершено", variant: "completed" };
  if (goal?.status === "stopped" || raid.notice)
    return { label: "Остановлено", variant: "unknown" };
  return { label: "Не запущено", variant: "unknown" };
}

export function BossBattleGoalPanel({
  state,
  goal,
  auto = { enabled: false },
  raid = state.raid ?? { enabled: false },
  onStart,
  onStopAuto,
  onStartRaid,
  onStopRaid,
}) {
  const id = useId();
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const settings = draft ?? defaultBattleSettings(state, goal);
  const update = (patch) => {
    setDraft({ ...settings, ...patch });
    setError(null);
  };
  const options = goalDropOptions(state.boss?.reference || state.boss);
  const config = battleSettingsConfig(settings, state.boss);
  const pending = Boolean(state.pending);
  const busy = auto.enabled || raid.enabled || pending;
  const eligible = canStartAutoSeries(state, {
    status: "active",
    canStart: true,
    canContinue: true,
  });
  const current = goal?.boss?.id === state.boss.id ? goal : null;
  const soloEnabled = auto.enabled && !raid.enabled;
  const status = executionStatus(state, current, auto, raid);
  const toggle = async () => {
    if (soloEnabled) {
      await onStopAuto();
      return;
    }
    if (!config || !eligible || pending) return;
    setError(null);
    if (!(await onStart(config)))
      setError(
        "Не удалось включить автобой. Обновите состояние и попробуйте снова.",
      );
  };
  return (
    <BaseCard
      className="boss-battle-goal-panel"
      aria-label="Цель и условия боя"
    >
      <div className="boss-battle-goal-heading">
        <CardTitle as="h3">Цель и условия боя</CardTitle>
        <Pill variant={status.variant} role="status" title={status.label}>
          {status.label}
        </Pill>
      </div>
      <SegmentedControl
        label="Цель боя"
        value={settings.kind}
        options={BOSS_GOAL_KINDS.map((option) => ({
          ...option,
          disabled: busy,
        }))}
        onChange={(kind) => update({ kind })}
      />
      {settings.kind !== "drops" && (
        <div>
          <NumberStepper
            id={`${id}-count`}
            label={
              settings.kind === "business_items"
                ? "Количество предметов"
                : settings.countWins
                  ? "Количество побед"
                  : "Количество боёв"
            }
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            rangeLabel={null}
            decrementLabel="Уменьшить количество"
            incrementLabel="Увеличить количество"
            value={Number(settings.target)}
            disabled={busy}
            onChange={(target) => update({ target: String(target) })}
          />
        </div>
      )}
      {settings.kind === "drops" && (
        <>
          <SegmentedControl
            label="Что собрать"
            value={settings.selection}
            options={[
              { value: "all", label: "Весь дроп", disabled: busy },
              { value: "selected", label: "Выбранный", disabled: busy },
            ]}
            onChange={(selection) =>
              update({
                selection,
                ...(selection === "selected"
                  ? { selectedKeys: options.map((item) => item.key) }
                  : {}),
              })
            }
          />
          {settings.selection === "selected" && (
            <div className="boss-battle-actions">
              {options.map((item) => (
                <Button
                  key={item.key}
                  disabled={busy}
                  aria-pressed={settings.selectedKeys.includes(item.key)}
                  onClick={() =>
                    update({
                      selectedKeys: settings.selectedKeys.includes(item.key)
                        ? settings.selectedKeys.filter(
                            (key) => key !== item.key,
                          )
                        : [...settings.selectedKeys, item.key],
                    })
                  }
                >
                  {item.name}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      <div>
        <FieldLabel>Сколько ходить</FieldLabel>
        <SegmentedControl
          label="Сколько ходить"
          value={settings.hours}
          options={["infinite", 1, 2, 4].map((hours) =>
            hours === "infinite"
              ? {
                  value: "infinite",
                  label: <Icon type="infinity-2" size="medium" />,
                  ariaLabel: "Без ограничений",
                  disabled: busy,
                }
              : {
                  value: String(hours),
                  label: `${hours} ч`,
                  disabled: busy,
                },
          )}
          onChange={(hours) => update({ hours })}
        />
      </div>
      {!config && (
        <CardDescription role="alert">
          Проверьте количество и доступный дроп.
        </CardDescription>
      )}
      {error && <CardDescription role="alert">{error}</CardDescription>}
      <div className="boss-battle-goal-actions">
        <Button
          variant="secondary"
          icon="sword"
          aria-pressed={soloEnabled}
          aria-label={soloEnabled ? "Остановить автобой" : "Запустить автобой"}
          disabled={
            !soloEnabled && (raid.enabled || pending || !config || !eligible)
          }
          onClick={() => void toggle()}
        >
          {soloEnabled ? "Остановить автобой" : "Запустить автобой"}
        </Button>
        {raid.enabled ? (
          <Button
            variant="secondary"
            icon="combat"
            aria-pressed="true"
            aria-label="Остановить рейд"
            onClick={() => void onStopRaid()}
          >
            Остановить рейд
          </Button>
        ) : (
          <Button
            variant="secondary"
            icon="combat"
            aria-pressed="false"
            aria-label="Запустить рейд"
            disabled={
              auto.enabled ||
              pending ||
              state.needsRefresh ||
              state.purchaseUncertain ||
              Boolean(state.purchase) ||
              state.medicineOpen ||
              Boolean(state.error) ||
              Boolean(state.pendingInvitation) ||
              state.battle?.status === "active" ||
              !config
            }
            onClick={() => void onStartRaid(config)}
          >
            Запустить рейд
          </Button>
        )}
      </div>
      {current && (
        <>
          <CardDescription role="status">
            Бои: {current.completedBattles} · Победы: {current.wins}
          </CardDescription>
          {current.target != null && current.kind !== "time" && (
            <ProgressBar
              label="Прогресс цели"
              displayText={`${current.progress} / ${current.target}`}
              value={Math.min(current.progress, current.target)}
              max={current.target}
            />
          )}
          {current.remainingSeconds != null && (
            <CardDescription>
              Осталось: {Math.ceil(current.remainingSeconds / 60)} мин
            </CardDescription>
          )}
          {current.rewardUncertain && (
            <CardDescription>
              Часть наград не подтверждена сервером.
            </CardDescription>
          )}
        </>
      )}
    </BaseCard>
  );
}
