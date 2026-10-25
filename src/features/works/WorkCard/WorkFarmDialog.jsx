import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RequirementCalculatorDialog } from "../../calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx";
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
  workEnergyRemaining,
} from "../WorkFarm/work-farm-plan.js";
import { fmt } from "../../../lib/format.js";
import "./WorkCalculatorDialog.css";

export function WorkFarmDialog({
  work,
  onClose,
  goalTargets = [],
  farmStore = workFarm,
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
  const run = state.run;
  const running = run?.status === "running";
  const active = running && run.workId === workId;
  const activeMode = run?.config?.mode ?? "wait";
  const requested = Math.max(
    0,
    ...goalTargets.map((item) => item.required).filter(Number.isSafeInteger),
  );
  const [count, setCount] = useState(null);
  const target =
    count ??
    (running && run.workId === workId
      ? run.targetCycles
      : requested || (view?.completedCycles ?? 0) + 1);
  const refreshed = useRef(null);
  useEffect(() => {
    if (!state.loaded) {
      refreshed.current = null;
      return;
    }
    if (view || running || state.pending || refreshed.current === workId)
      return;
    refreshed.current = workId;
    void farmStore.refresh(workId);
  }, [farmStore, workId, view, state.loaded, state.pending, running]);
  const [launchError, setLaunchError] = useState(null);
  const completed = view?.completedCycles ?? 0;
  const remaining = view ? Math.max(0, target - completed) : null;
  const totalEnergy = useMemo(
    () => (view ? workEnergyRemaining(view, target) : null),
    [view, target],
  );
  const purchase = useMemo(() => {
    if (
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
        maxActions: 30000,
        maxBoosters: 1000,
        maxDollar: view.walletDollar,
        allowPurchase: true,
      });
    } catch {
      return null;
    }
  }, [view, target, completed]);
  const energyPlan = useMemo(() => {
    if (!view || totalEnergy == null) return null;
    const missing = Math.max(0, totalEnergy - view.energy.current);
    const seconds = !missing
      ? 0
      : view.energy.secondsToNext != null && view.energy.regenIntervalSeconds
        ? view.energy.secondsToNext +
          (missing - 1) * view.energy.regenIntervalSeconds
        : null;
    const refills =
      purchase?.actions?.filter((action) => action.kind === "refill") ?? [];
    return {
      minutes: seconds == null ? null : Math.ceil(seconds / 60),
      smallRefills: purchase?.feasible
        ? refills.filter((action) => action.type === "small").length
        : null,
      largeRefills: purchase?.feasible
        ? refills.filter((action) => action.type === "full").length
        : null,
      banknotes: purchase?.feasible ? purchase.spentDollar : null,
    };
  }, [view, totalEnergy, purchase]);
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
      status: view ? "ready" : state.error ? "error" : "loading",
      energy: view
        ? { currentEnergy: view.energy.current, maxEnergy: view.energy.max }
        : null,
    }),
    [view, state.error],
  );
  const ready = Boolean(
    view &&
    Number.isSafeInteger(target) &&
    target > completed &&
    target - completed <= 1000 &&
    !state.pending &&
    !running,
  );
  async function start(mode) {
    if (!ready || (mode === "boosters" && !purchase?.feasible)) return;
    setLaunchError(null);
    const ok = await farmStore.start({
      workId,
      targetCycles: target,
      mode,
      maxActions: 30000,
      durationHours: null,
      maxBoosters: mode === "boosters" ? purchase.usedBoosters : 0,
      allowPurchase: mode === "boosters",
      maxDollar: mode === "boosters" ? purchase.spentDollar : 0,
      expectedCompletedCycles: completed,
    });
    if (!ok) setLaunchError("Не удалось начать фарм. Обновите данные.");
  }
  const activeProgress = active && (
    <div
      className="work-calculator-goal"
      aria-label="Прогресс выбранного варианта"
    >
      <LoadingStatus>
        {run.phase === "waiting" ? "Ожидание энергии" : "Фарм идёт"} ·{" "}
        {fmt(run.completedCycles ?? completed)} из {fmt(run.targetCycles)}
      </LoadingStatus>
      <ProgressBar
        value={run.completedCycles ?? completed}
        max={run.targetCycles}
        label="Прогресс фарма"
        valueText={`${fmt(run.completedCycles ?? completed)} из ${fmt(run.targetCycles)}`}
      />
      <Button onClick={() => void farmStore.stop()}>Остановить</Button>
    </div>
  );
  return (
    <RequirementCalculatorDialog
      showCloseButton
      loading={(!state.loaded && !state.error) || state.pending || active}
      contentLoading={!view && !state.error}
      conditionDialog={condition}
      title={`Фарм · ${work.title || work.name || "Работёнка"}`}
      onClose={onClose}
      countControl={{
        value: String(remaining ?? Math.max(0, target - completed)),
        onChange: (value) => setCount(completed + Number(value)),
        min: 0,
        max: 1000,
        label: "Количество оставшихся выполнений",
        rangeLabel: "Осталось выполнений работы",
        unitEnergy: null,
      }}
      accountState={account}
      energyOverride={totalEnergy}
      recoveryPlan={energyPlan}
      intro={
        <>
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
          {view && !goalTargets.length && (
            <CardDescription>
              Выполнено: {fmt(completed)} · осталось: {fmt(remaining)}
            </CardDescription>
          )}
          {(state.notice || state.error || launchError) && (
            <BaseCard role="alert">
              <CardDescription
                title={state.notice || state.error || launchError}
              >
                {state.notice || state.error || launchError}
              </CardDescription>
            </BaseCard>
          )}
        </>
      }
      optionActions={{
        wait:
          active && activeMode === "wait" ? (
            activeProgress
          ) : (
            <Button disabled={!ready} onClick={() => void start("wait")}>
              Начать фарм
            </Button>
          ),
        purchase:
          active && activeMode === "boosters" ? (
            activeProgress
          ) : (
            <Button
              disabled={!ready || !purchase?.feasible}
              onClick={() => void start("boosters")}
            >
              {purchase?.feasible && purchase.spentDollar > 0
                ? `Купить за ${fmt(purchase.spentDollar)} купюр и начать фарм`
                : "Начать фарм"}
            </Button>
          ),
      }}
      afterOptions={
        run &&
        !active && (
          <BaseCard className="work-calculator-goal">
            <CardDescription title={run.reason}>
              {running
                ? `Фарм идёт · ${run.completedCycles ?? completed} / ${run.targetCycles}`
                : run.reason || "Фарм остановлен"}
            </CardDescription>
            {running && (
              <Button onClick={() => void farmStore.stop()}>Остановить</Button>
            )}
          </BaseCard>
        )
      }
    />
  );
}
