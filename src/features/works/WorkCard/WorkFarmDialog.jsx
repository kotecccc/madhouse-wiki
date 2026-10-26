import { WorkStashCard } from "./WorkStashCard.jsx";
import {
  getSessionJson,
  peekSessionJson,
  peekSessionUpdatedAt,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import {
  calculateCycleEnergy,
  calculateRequirementEnergy,
} from "../../../lib/energy.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { RequirementCalculatorDialog } from "../../calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { LoadingStatus } from "../../../components/ui/LoadingStatus/LoadingStatus.jsx";
import { ProgressBar } from "../../../components/ui/ProgressBar/ProgressBar.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { workFarm } from "../../bosses/BossBattle/boss-battle-session.js";
import {
  planWorkFarm,
  latestWorkEnergy,
  workEnergyRemaining,
} from "../WorkFarm/work-farm-plan.js";
import { fmt, restoreTime } from "../../../lib/format.js";
import { SegmentedControl } from "../../../components/ui/SegmentedControl/SegmentedControl.jsx";
import {
  previewWorkTasks,
  workFarmProgress,
} from "../WorkFarm/work-farm-presentation.js";
import "./WorkCalculatorDialog.css";

const validEnergy = (value) =>
  Number.isSafeInteger(value?.current) &&
  value.current >= 0 &&
  Number.isSafeInteger(value?.max) &&
  value.max > 0 &&
  value.current <= value.max;

export function WorkFarmDialog({
  work,
  energy,
  onClose,
  goalTargets = [],
  farmStore = workFarm,
  profileSnapshot,
}) {
  const state = useSyncExternalStore(
    farmStore.subscribe,
    farmStore.getSnapshot,
    farmStore.getSnapshot,
  );
  const workId = Number(
    work.workId ??
      work.numericId ??
      work.apiId ??
      String(work.id).split(":").at(-1),
  );
  const view = state.view?.workId === workId ? state.view : null;
  const [profile, setProfile] = useState(
    () => profileSnapshot ?? peekSessionJson("/api/me", { allowStale: true }),
  );
  const [profileUpdatedAt, setProfileUpdatedAt] = useState(
    () => peekSessionUpdatedAt("/api/me") ?? 0,
  );
  const [profileFailed, setProfileFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSessionData((event) => {
      if (event.cleared) {
        setProfile(null);
        setProfileUpdatedAt(0);
      } else if (event.path === "/api/me") {
        setProfile(event.data);
        setProfileUpdatedAt(event.updatedAt ?? 0);
        setProfileFailed(!validEnergy(event.data?.energy));
      }
    });
    void getSessionJson("/api/me", { fresh: true, serverRefresh: "live" })
      .then((data) => {
        if (active) {
          setProfile(data);
          setProfileUpdatedAt(peekSessionUpdatedAt("/api/me") ?? 0);
          setProfileFailed(!validEnergy(data?.energy));
        }
      })
      .catch(() => {
        if (active) setProfileFailed(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const knownEnergy = latestWorkEnergy(view, profile, profileUpdatedAt);
  const run = state.run;
  const running = run?.status === "running";
  const active = running && run.workId === workId;
  const activeMode = run?.config?.mode ?? "wait";
  const [selectedOption, setSelectedOption] = useState(() =>
    (active && activeMode === "boosters") ||
    state.configs?.[workId]?.mode === "boosters"
      ? "purchase"
      : "wait",
  );
  const effectiveOption = active
    ? activeMode === "boosters"
      ? "purchase"
      : "wait"
    : selectedOption;

  const [maxMode, setMaxMode] = useState(
    () => active && activeMode === "energy",
  );
  const energyOnly = active ? activeMode === "energy" : maxMode;
  const energyBudget =
    active && energyOnly
      ? Math.max(0, (run.energyBudget ?? 0) - (run.energySpent ?? 0))
      : (knownEnergy?.current ?? null);
  // These are observation retries only. The server remains the sole executor.
  useEffect(() => {
    if (!state.loaded) return;
    let disposed = false;
    let timer;
    const refresh = async () => {
      const current = farmStore.getSnapshot();
      if (!current.pending && current.run?.status !== "running") {
        await farmStore.refresh(workId);
      }
      if (!disposed)
        timer = window.setTimeout(refresh, current.pending ? 1000 : 30000);
    };
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [farmStore, workId, state.loaded]);

  const requested = Math.max(
    0,
    ...goalTargets.map((item) => item.required).filter(Number.isSafeInteger),
  );
  const [count, setCount] = useState(null);
  const completed = view?.completedCycles ?? 0;
  const target = active
    ? run.targetCycles
    : count != null
      ? completed + count
      : Math.max(completed + 1, requested || completed + 1);
  const [launchError, setLaunchError] = useState(null);
  const remaining = Math.max(0, target - completed);
  const totalEnergy = useMemo(
    () =>
      energyOnly
        ? energyBudget
        : view
          ? workEnergyRemaining(view, target)
          : (calculateCycleEnergy(energy ?? work.energyCycle?.full, remaining)
              ?.total ?? null),
    [
      view,
      target,
      energy,
      work.energyCycle?.full,
      remaining,
      energyOnly,
      energyBudget,
    ],
  );
  const purchase = useMemo(() => {
    if (
      energyOnly ||
      !view ||
      view.boosters?.length !== 2 ||
      view.walletDollar == null ||
      target <= completed
    )
      return null;
    try {
      return planWorkFarm(view, {
        targetCycles: target,
        mode: "boosters",
        maxActions: active
          ? Math.max(0, run.config.maxActions - run.actionsDone)
          : 30000,
        maxBoosters: active
          ? Math.max(0, run.config.maxBoosters - run.usedBoosters)
          : 1000,
        maxDollar: active
          ? Math.max(0, run.config.maxDollar - run.spentDollar)
          : view.walletDollar,
        allowPurchase: active ? run.config.allowPurchase : true,
      });
    } catch {
      return null;
    }
  }, [view, target, completed, energyOnly, active, run]);
  const energyPlan = useMemo(() => {
    if (totalEnergy == null) return null;
    if (energyOnly)
      return { minutes: 0, smallRefills: 0, largeRefills: 0, banknotes: 0 };
    if (!view) {
      const estimate = knownEnergy
        ? calculateRequirementEnergy(
            totalEnergy,
            knownEnergy.max,
            knownEnergy.current,
          )
        : null;
      return {
        minutes: estimate?.minutes ?? null,
        smallRefills: null,
        largeRefills: null,
        banknotes: null,
      };
    }
    const availableEnergy = knownEnergy ?? view.energy;
    const missing = Math.max(0, totalEnergy - availableEnergy.current);
    const seconds = !missing
      ? 0
      : availableEnergy.secondsToNext != null &&
          availableEnergy.regenIntervalSeconds
        ? availableEnergy.secondsToNext +
          (missing - 1) * availableEnergy.regenIntervalSeconds
        : null;
    return { minutes: seconds == null ? null : Math.ceil(seconds / 60) };
  }, [view, totalEnergy, knownEnergy, energyOnly]);
  const condition = useMemo(
    () => ({
      energy: totalEnergy,
      requirement: {
        type: "work_completions",
        label: work.title || work.name,
        targetDepartmentId: work.departmentId,
      },
    }),
    [totalEnergy, work],
  );
  const account = useMemo(
    () => ({
      status: knownEnergy
        ? "ready"
        : state.error || profileFailed
          ? "error"
          : "loading",
      energy: knownEnergy
        ? { currentEnergy: knownEnergy.current, maxEnergy: knownEnergy.max }
        : null,
    }),
    [knownEnergy, state.error, profileFailed],
  );
  const ready = Boolean(
    Number.isSafeInteger(target) &&
    target > completed &&
    target - completed <= 1000 &&
    !state.pending &&
    !running &&
    state.loaded,
  );
  async function start(mode) {
    if (!ready || (!energyOnly && mode === "boosters" && !purchase?.feasible))
      return;
    if (energyOnly) mode = "energy";
    setLaunchError(null);
    const ok = await farmStore.start({
      workId,
      targetCycles: energyOnly ? completed + 1 : target,
      mode,
      maxActions: 30000,
      durationHours: null,
      maxBoosters: mode === "boosters" ? purchase.usedBoosters : 0,
      allowPurchase: mode === "boosters",
      maxDollar: mode === "boosters" ? purchase.spentDollar : 0,
      expectedCompletedCycles: completed,
      ...(energyOnly && energyBudget != null ? { energyBudget } : {}),
    });
    if (!ok) {
      const latest = farmStore.getSnapshot();
      if (latest.run?.status !== "running") {
        setLaunchError(
          latest.notice ||
            "Запуск пока не подтверждён. Проверяем состояние задачи.",
        );
      }
    }
  }
  const taskPreview = useMemo(
    () =>
      previewWorkTasks(
        view && knownEnergy ? { ...view, energy: knownEnergy } : view,
        {
          mode: energyOnly ? "energy" : "wait",
          targetCycles: target,
          energyBudget,
          maxActions: active
            ? Math.max(0, run.config.maxActions - run.actionsDone)
            : 30000,
        },
      ),
    [view, knownEnergy, energyOnly, target, energyBudget, active, run],
  );
  const progress = workFarmProgress(run, view);
  const activeProgress = active && (
    <div
      className="work-calculator-goal"
      aria-label="Прогресс выбранного варианта"
    >
      <LoadingStatus>
        {run.reason ? (
          run.reason
        ) : energyOnly ? (
          `Работа идёт · ${fmt(run.energySpent ?? 0)} из ${fmt(run.energyBudget ?? 0)} энергии`
        ) : (
          <>
            {run.phase === "waiting" ? "Ожидание энергии" : "Фарм идёт"} ·{" "}
            {progress.percent == null ? "—" : `${progress.percent}%`}
          </>
        )}
      </LoadingStatus>
      {progress.max != null && (
        <ProgressBar
          value={progress.value}
          max={progress.max}
          label={energyOnly ? "Расход энергии" : "Прогресс фарма"}
          valueText={
            energyOnly
              ? `${fmt(run.energySpent ?? 0)} из ${fmt(run.energyBudget ?? 0)} энергии`
              : `${fmt(progress.value)} из ${fmt(progress.max)} энергии до цели`
          }
        />
      )}
    </div>
  );
  return (
    <RequirementCalculatorDialog
      showCloseButton
      loading={
        (!view && !state.error && !state.notice) || state.pending || active
      }
      boostersLoading={!view && !state.error && !state.notice}
      conditionDialog={condition}
      title={`Работа · ${work.title || work.name || "Работёнка"}`}
      footerStart={<Button onClick={onClose}>Закрыть</Button>}
      footer={
        running ? (
          <Button icon="stop" onClick={() => void farmStore.stop()}>
            Остановить
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={
              !ready ||
              (!energyOnly &&
                effectiveOption === "purchase" &&
                !purchase?.feasible)
            }
            onClick={() =>
              void start(effectiveOption === "purchase" ? "boosters" : "wait")
            }
          >
            {!energyOnly &&
            effectiveOption === "purchase" &&
            purchase?.feasible &&
            purchase.spentDollar > 0
              ? `Фарм за ${fmt(purchase.spentDollar)} купюр`
              : "Начать фарм"}
          </Button>
        )
      }
      showCalculation={false}
      afterOptions={
        <>
          {!energyOnly && (
            <SegmentedControl
              label="Восстановление энергии"
              value={effectiveOption}
              onChange={setSelectedOption}
              options={[
                {
                  value: "wait",
                  disabled: running,
                  label: `Ждать · ${energyPlan?.minutes == null ? "—" : restoreTime(energyPlan.minutes)}`,
                },
                {
                  value: "purchase",
                  disabled: running,
                  label: `Дефибрилляторы · ${purchase?.feasible ? fmt(purchase.spentDollar) : "—"} купюр`,
                },
              ]}
            />
          )}
          {!energyOnly && effectiveOption === "purchase" && (
            <CardDescription>
              {purchase?.feasible
                ? `Дефибрилляторов: ${fmt(purchase.usedBoosters)}. Расход — не более ${fmt(purchase.spentDollar)} купюр.`
                : "Проверяем запас и стоимость дефибрилляторов. Покупки начнутся только после подтверждения бюджета."}
            </CardDescription>
          )}
          <div className="work-calculator-goal" aria-label="План заданий">
            <CardTitle as="h3">Будут выполнены</CardTitle>
            {!taskPreview ? (
              <LoadingStatus>
                Получаем задания. Повторим проверку автоматически.
              </LoadingStatus>
            ) : taskPreview.items.length === 0 ? (
              <CardDescription>
                {energyOnly
                  ? "Сейчас нет доступных заданий в пределах выбранного запаса энергии."
                  : "Все задания выбранной цели выполнены."}
              </CardDescription>
            ) : (
              <>
                <CardDescription>
                  {energyOnly
                    ? "В пределах оставшейся энергии, без покупок."
                    : "Оставшиеся действия до выбранной цели."}{" "}
                  План уточняется после каждого подтверждённого действия.
                </CardDescription>
                {taskPreview.items.map((task) => (
                  <BaseCard variant="floor-data" key={task.id}>
                    <CardTitle as="h4" size="sm">
                      {task.title}
                    </CardTitle>
                    <CardDescription>
                      ×{fmt(task.count)} · {fmt(task.energy)}{" "}
                      <Icon type="energy" size="text" />
                    </CardDescription>
                  </BaseCard>
                ))}
              </>
            )}
          </div>
          {active ? (
            <BaseCard>{activeProgress}</BaseCard>
          ) : running ? (
            <BaseCard className="work-calculator-goal">
              <CardDescription title={run.reason}>
                Другая работёнка уже выполняется. Остановите её, чтобы сменить
                цель.
              </CardDescription>
            </BaseCard>
          ) : null}
        </>
      }
      onClose={onClose}
      countControl={{
        value: String(Math.max(1, remaining)),
        onChange: (value) => setCount(Math.max(1, Number(value))),
        min: 1,
        maxToggle: {
          active: energyOnly,
          onToggle: () => setMaxMode((value) => !value),
          disabled: running,
          label: (
            <>
              MAX {energyBudget == null ? "—" : fmt(energyBudget)}{" "}
              <Icon type="energy" size="text" />
            </>
          ),
        },
        disabled: active,
        max: 1000,
        label: "Количество выполнений",
        rangeLabel: "Количество выполнений",
        unitEnergy: null,
      }}
      accountState={account}
      energyOverride={totalEnergy}
      intro={
        <>
          <WorkStashCard work={work} stash={view?.stash} />
          {goalTargets.map((item) => {
            const goalTotal = Number.isSafeInteger(item.required)
              ? item.required
              : target;
            const left = Math.max(0, goalTotal - completed);
            return (
              <BaseCard
                key={`${item.destination}-${item.label}`}
                className="work-calculator-goal"
              >
                <div className="work-calculator-goal-row">
                  <div className="work-calculator-goal-copy">
                    <CardTitle>Для открытия {item.destination}</CardTitle>
                    <CardDescription title={item.label}>
                      {item.label}
                    </CardDescription>
                  </div>
                  {view && (
                    <Pill
                      variant={left === 0 ? "completed" : "active"}
                      dot={false}
                      title={`Осталось: ${fmt(left)}`}
                      aria-label={`${fmt(completed)} из ${fmt(goalTotal)}, осталось ${fmt(left)}`}
                    >
                      {fmt(completed)} из {fmt(goalTotal)}
                    </Pill>
                  )}
                </div>
              </BaseCard>
            );
          })}
          {!running &&
            run?.workId === workId &&
            ["limited", "error"].includes(run.status) &&
            run.reason && (
              <BaseCard role="status">
                <CardDescription>{run.reason}</CardDescription>
              </BaseCard>
            )}
          {launchError && !running && (
            <BaseCard role="alert">
              <CardDescription title={launchError}>
                {launchError}
              </CardDescription>
            </BaseCard>
          )}
        </>
      }
    />
  );
}
