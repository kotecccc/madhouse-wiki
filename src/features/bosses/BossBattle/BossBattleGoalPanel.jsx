import { InfoButton } from "../../../components/ui/InfoButton/InfoButton.jsx";
import {
  goalProgressPresentation,
  bossAutomationEligible,
} from "./boss-battle-presentation.js";
import { useId, useState } from "react";
import { createPortal } from "react-dom";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { Disclosure } from "../../../components/ui/Disclosure/Disclosure.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { FieldLabel } from "../../../components/ui/FieldLabel/FieldLabel.jsx";
import { NumberStepper } from "../../../components/ui/NumberStepper/NumberStepper.jsx";
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import {
  BOSS_GOAL_KINDS,
  goalDropOptions,
  isShopGoalDrop,
  defaultBattleSettings,
  battleSettingsConfig,
} from "./boss-goal-options.js";
import "./BossBattleGoalPanel.css";

export function BossBattleGoalPanel({
  state,
  goal,
  auto = { enabled: false },
  raid = state.raid ?? { enabled: false },
  onStart,
  onStopAuto,
  onStartRaid,
  onStopRaid,
  actionsTarget,
  now = Date.now(),
}) {
  const bossId = Number(state.boss.id);
  const current = Number(goal?.boss?.id) === bossId ? goal : null;
  const foreignGoal = goal?.boss?.id != null && !current;
  const foreignRaid = raid.bossId != null && Number(raid.bossId) !== bossId;
  if (foreignGoal || (foreignRaid && raid.enabled)) auto = { enabled: false };
  if (foreignRaid) raid = { enabled: false };
  const id = useId();
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const settings = draft ?? defaultBattleSettings(state, current);
  const update = (patch) => {
    setDraft({ ...settings, ...patch });
    setError(null);
  };
  const options = goalDropOptions(state.boss?.reference || state.boss);
  const shopOptions = options.filter(isShopGoalDrop);
  const config = battleSettingsConfig(settings, state.boss);
  const pending = Boolean(state.pending);
  const busy = auto.enabled || raid.enabled || pending;
  const eligible = bossAutomationEligible(state);
  const soloEnabled = auto.enabled && !raid.enabled;
  const progressStatus = goalProgressPresentation(current, now);
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
  const actions = (
    <div className="boss-battle-goal-actions">
      <Button
        variant={soloEnabled ? "secondary" : "primary"}
        icon={soloEnabled ? "pause" : "combat"}
        aria-pressed={soloEnabled}
        aria-label={soloEnabled ? "Остановить автобой" : "Начать автобой"}
        disabled={
          !soloEnabled && (raid.enabled || pending || !config || !eligible)
        }
        onClick={() => void toggle()}
      >
        {soloEnabled ? "Остановить автобой" : "Начать автобой"}
      </Button>
      {raid.enabled ? (
        <Button
          variant="secondary"
          icon="pause"
          aria-pressed="true"
          aria-label={
            raid.stopAfterBattle ? "Завершаем бой" : "Остановить рейд"
          }
          disabled={raid.stopAfterBattle}
          onClick={() => void onStopRaid()}
        >
          {raid.stopAfterBattle ? "Завершаем бой" : "Остановить рейд"}
        </Button>
      ) : (
        <Button
          variant="secondary"
          icon="play"
          aria-pressed="false"
          aria-label="Запустить рейд"
          disabled={
            auto.enabled ||
            !eligible ||
            state.battle?.status === "active" ||
            !config
          }
          onClick={() => void onStartRaid(config)}
        >
          Запустить рейд
        </Button>
      )}
      <InfoButton
        label="Как работает рейд"
        description="Рейд сначала ищет приглашение. Если его нет, открывает свой бой; лимиты лечения и покупок сохраняются. При остановке текущий бой продолжается до завершения."
      />
    </div>
  );
  return (
    <>
      <Disclosure
        key={`${auto.enabled || raid.enabled}:${Boolean(state.battle)}`}
        title="Цель и условия боя"
        size="sm"
        leading={<Icon type="target" size="medium" />}
        defaultOpen={!auto.enabled && !raid.enabled && !state.battle}
        status={
          <Pill
            variant={progressStatus ? "active" : "unknown"}
            size="xs"
            dot={false}
          >
            {progressStatus ? (
              <>
                <Icon type={progressStatus.icon} size="small" />
                {progressStatus.progress}
                {progressStatus.timer && (
                  <>
                    {progressStatus.progress && " · "}
                    {progressStatus.timer}
                  </>
                )}
                {!progressStatus.progress && !progressStatus.timer && (
                  <Icon type="infinity-2" size="small" />
                )}
              </>
            ) : (
              "Не установлена"
            )}
          </Pill>
        }
      >
        <div className="boss-battle-goal-panel">
          <SegmentedControl
            size="sm"
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
                size="sm"
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
                      ? { selectedKeys: shopOptions.map((item) => item.key) }
                      : {}),
                  })
                }
              />
              {settings.selection === "selected" && (
                <div className="boss-battle-actions">
                  {shopOptions.map((item) => (
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
              size="sm"
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
        </div>
      </Disclosure>
      {actionsTarget === undefined
        ? actions
        : actionsTarget && createPortal(actions, actionsTarget)}
    </>
  );
}
