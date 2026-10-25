import { useId, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { NumberField } from "../../../components/ui/NumberField/NumberField.jsx";
import { SelectField } from "../../../components/ui/SelectField/SelectField.jsx";
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

const statuses = {
  active: "Автобой настроен",
  completed: "Выполнено",
  exhausted: "Попытки закончились",
  expired: "Время вышло",
  stopped: "Остановлено",
};

export function BossBattleGoalPanel({
  state,
  goal,
  auto = { enabled: false },
  onStart,
  onStopAuto,
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
  const busy = auto.enabled || pending;
  const eligible = canStartAutoSeries(state, {
    status: "active",
    canStart: true,
    canContinue: true,
  });
  const current = goal?.boss?.id === state.boss.id ? goal : null;
  const toggle = async () => {
    if (auto.enabled) {
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
    <BaseCard className="boss-battle-goal-panel" aria-label="Автобой">
      <CardTitle as="h3">Автобой</CardTitle>
      <SegmentedControl
        label="Режим автобоя"
        value={settings.kind}
        options={BOSS_GOAL_KINDS.map((option) => ({
          ...option,
          disabled: busy,
        }))}
        onChange={(kind) => update({ kind })}
      />
      {settings.kind !== "drops" && (
        <div>
          <NumberField
            id={`${id}-count`}
            label={
              settings.kind === "business_items"
                ? "Количество предметов"
                : settings.countWins
                  ? "Количество побед"
                  : "Количество боёв"
            }
            suffix={
              settings.kind === "business_items"
                ? "шт."
                : settings.countWins
                  ? "побед"
                  : "боёв"
            }
            min="1"
            value={settings.target}
            disabled={busy}
            spacing="none"
            onChange={(event) => update({ target: event.target.value })}
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
        <SelectField
          id={`${id}-hours`}
          label="Сколько ходить"
          value={settings.hours}
          disabled={busy}
          spacing="none"
          options={[1, 2, 4]
            .map((hours) => ({
              id: String(hours),
              value: String(hours),
              label: `${hours} ч`,
            }))
            .concat({
              id: "infinite",
              value: "infinite",
              label: "Без ограничения",
            })}
          onChange={(event) => update({ hours: event.target.value })}
        />
      </div>
      {!config && (
        <CardDescription role="alert">
          Проверьте количество и доступный дроп.
        </CardDescription>
      )}
      {error && <CardDescription role="alert">{error}</CardDescription>}
      <Button
        variant={auto.enabled ? "secondary" : "primary"}
        icon="combat"
        aria-pressed={auto.enabled}
        aria-label={auto.enabled ? "Выключить автобой" : "Включить автобой"}
        disabled={!auto.enabled && (pending || !config || !eligible)}
        onClick={() => void toggle()}
      >
        {auto.enabled ? "Выключить" : "Включить"}
      </Button>
      {current && (
        <>
          <CardDescription role="status">
            {auto.enabled ? "Автобой включён" : statuses[current.status]} · Бои:{" "}
            {current.completedBattles} · Победы: {current.wins}
          </CardDescription>
          {current.target != null && current.kind !== "time" && (
            <ProgressBar
              label="Прогресс автобоя"
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
