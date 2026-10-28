import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { InfoButton } from "../../../components/ui/InfoButton/InfoButton.jsx";
import { goalProgressPresentation } from "./boss-battle-presentation.js";
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
  menuActions = false,
  disableStart = false,
  queueInsteadOfStart = false,
  hideSettings = false,
  now = Date.now(),
}) {
  const bossId = Number(state.boss.id);
  const current = Number(goal?.boss?.id) === bossId ? goal : null;
  const foreignGoal = goal?.boss?.id != null && !current;
  const foreignRaid = raid.bossId != null && Number(raid.bossId) !== bossId;
  if (foreignGoal || (foreignRaid && (raid.enabled || raid.userPaused)))
    auto = { enabled: false };
  if (foreignRaid) raid = { enabled: false };
  const id = useId();
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [selectedMode, setSelectedMode] = useState("auto");
  const settings = draft ?? defaultBattleSettings(state, current);
  const update = (patch) => {
    setDraft({ ...settings, ...patch });
    setError(null);
  };
  const config = battleSettingsConfig(
    { ...settings, selection: "all" },
    state.boss,
  );
  const pending = Boolean(state.pending);
  const raidActive = raid.enabled || raid.userPaused;
  const autoActive = auto.enabled || auto.userPaused;
  const busy = autoActive || raidActive || pending;
  const soloEnabled = autoActive && !raidActive;
  const mode = raidActive ? "raid" : soloEnabled ? "auto" : selectedMode;
  const isQueued = (type) =>
    state.queuedSeries?.some(
      (job) =>
        job.type === `${type}.start` && Number(job.args?.bossId) === bossId,
    );
  const queuedAuto = isQueued("auto");
  const queuedRaid = isQueued("raid");
  const queuedMode = mode === "raid" ? queuedRaid : queuedAuto;
  const progressStatus = goalProgressPresentation(current, now);
  const autoLabel = queuedAuto
    ? "Автобой в очереди"
    : queueInsteadOfStart
      ? "В очередь автобоя"
      : "Начать автобой";
  const raidLabel = queuedRaid
    ? "Рейд в очереди"
    : queueInsteadOfStart
      ? "В очередь рейдов"
      : "Запустить рейд";
  const toggle = async () => {
    if (soloEnabled) {
      await onStopAuto();
      return;
    }
    if (!config) return;
    setError(null);
    if (!(await onStart(config)))
      setError(
        "Не удалось включить автобой. Обновите состояние и попробуйте снова.",
      );
  };
  const queueRaid = async () => {
    if (!config) return;
    setError(null);
    if (!(await onStartRaid(config)))
      setError("Не удалось добавить рейд в очередь.");
  };
  const actions = menuActions ? (
    <div className="boss-battle-goal-action">
      <Button
        variant="nav-tab"
        icon={
          raidActive || soloEnabled
            ? "pause"
            : mode === "raid"
              ? "play"
              : "robot"
        }
        iconSize="large"
        aria-pressed={raidActive || soloEnabled}
        aria-label={
          raidActive
            ? raid.stopAfterBattle
              ? "Завершаем бой"
              : "Остановить рейд"
            : soloEnabled
              ? auto.stopAfterBattle
                ? "Завершаем бой"
                : "Остановить автобой"
              : mode === "raid"
                ? raidLabel
                : autoLabel
        }
        disabled={
          disableStart ||
          (soloEnabled && auto.stopAfterBattle) ||
          (!raidActive && !soloEnabled && queuedMode) ||
          (raidActive
            ? raid.stopAfterBattle
            : !soloEnabled && (!config || pending))
        }
        onClick={() => {
          if (raidActive) {
            setSelectedMode("raid");
            void onStopRaid();
          } else if (mode === "raid") void queueRaid();
          else void toggle();
        }}
      >
        {raidActive
          ? raid.stopAfterBattle
            ? "Завершаем бой"
            : "Остановить рейд"
          : soloEnabled
            ? auto.stopAfterBattle
              ? "Завершаем бой"
              : "Остановить автобой"
            : mode === "raid"
              ? raidLabel
              : autoLabel}
      </Button>
    </div>
  ) : (
    <div className="boss-battle-goal-actions">
      <Button
        variant={
          menuActions ? "nav-tab" : soloEnabled ? "secondary" : "primary"
        }
        icon={soloEnabled ? "pause" : "robot"}
        iconSize={menuActions ? "large" : undefined}
        aria-pressed={soloEnabled}
        aria-label={
          soloEnabled
            ? auto.stopAfterBattle
              ? "Завершаем бой"
              : "Остановить автобой"
            : autoLabel
        }
        disabled={
          Boolean(auto.stopAfterBattle) ||
          (!soloEnabled && (!config || queuedAuto))
        }
        onClick={() => void toggle()}
      >
        {soloEnabled
          ? auto.stopAfterBattle
            ? "Завершаем бой"
            : "Остановить автобой"
          : autoLabel}
      </Button>
      {raidActive ? (
        <Button
          variant={menuActions ? "nav-tab" : "secondary"}
          icon="pause"
          iconSize={menuActions ? "large" : undefined}
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
          variant={menuActions ? "nav-tab" : "secondary"}
          icon="play"
          iconSize={menuActions ? "large" : undefined}
          aria-pressed="false"
          aria-label={raidLabel}
          disabled={!config || queuedRaid}
          onClick={() => void queueRaid()}
        >
          {raidLabel}
        </Button>
      )}
      <InfoButton
        label="Как работает рейд"
        description="Рейд сначала ищет приглашение. Если его нет, открывает свой бой; лимиты лечения и покупок сохраняются. При остановке текущий бой продолжается до завершения."
      />
    </div>
  );
  const duration = (
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
  );
  const goalControls = (
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
      {!menuActions && duration}
      <ErrorToast message={error} />
    </div>
  );
  return (
    <>
      {!hideSettings && menuActions && (
        <div>
          <SegmentedControl
            size="sm"
            label="Режим боя"
            value={mode}
            options={[
              { value: "auto", label: "Автобой", disabled: busy },
              { value: "raid", label: "Рейд", disabled: busy },
            ]}
            onChange={setSelectedMode}
          />
        </div>
      )}
      {!hideSettings && menuActions && (
        <div>
          <FieldLabel>Цель и условия боя</FieldLabel>
          {goalControls}
        </div>
      )}
      {!hideSettings && !menuActions && (
        <Disclosure
          key={`${autoActive || raidActive}:${Boolean(state.battle)}`}
          title="Цель и условия боя"
          size="sm"
          leading={<Icon type="target" size="medium" />}
          defaultOpen={!autoActive && !raidActive && !state.battle}
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
          {goalControls}
        </Disclosure>
      )}
      {!hideSettings && menuActions && duration}
      {actionsTarget === undefined
        ? actions
        : actionsTarget && createPortal(actions, actionsTarget)}
    </>
  );
}
