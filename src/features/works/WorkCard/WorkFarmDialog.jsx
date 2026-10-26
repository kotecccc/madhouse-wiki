import { WorkStashCard } from "./WorkStashCard.jsx";
import {
  readRetryStartedAt,
  writeRetryStartedAt,
  retrySeconds as remainingRetrySeconds,
} from "../../../../shared/retry-countdown.js";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import {
  calculateCycleEnergy,
  calculateRequirementEnergy,
} from "../../../lib/energy.js";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  workEnergyRemaining,
} from "../WorkFarm/work-farm-plan.js";
import { fmt } from "../../../lib/format.js";
import "./WorkCalculatorDialog.css";

const WORK_RETRY_KEY = "madhouse:work-refresh-started-at:v1";

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
  const [profileFailed, setProfileFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSessionData((event) => {
      if (event.cleared) setProfile(null);
      else if (event.path === "/api/me") {
        setProfile(event.data);
        setProfileFailed(!validEnergy(event.data?.energy));
      }
    });
    void getSessionJson("/api/me")
      .then((data) => {
        if (active) {
          setProfile(data);
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
  const cachedEnergy = profile?.energy;
  const knownEnergy =
    view?.energy ?? (validEnergy(cachedEnergy) ? cachedEnergy : null);
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
  const refreshIssue = state.error || (!view ? state.notice : null);
  const serviceUnavailable = Boolean(refreshIssue);
  const [retryNow, setRetryNow] = useState(Date.now);
  const [retryStartedAt, setRetryStartedAt] = useState(() =>
    readRetryStartedAt(WORK_RETRY_KEY),
  );
  const retryLocalUntil = retryStartedAt ? retryStartedAt + 60000 : 0;
  const retryUntil = Math.max(retryLocalUntil, state.refreshRetryAt || 0);
  const retrySeconds = remainingRetrySeconds(
    retryUntil,
    Math.max(retryNow, Date.now()),
  );
  const retryPending = useRef(false);
  useEffect(() => {
    const now = Date.now();
    if (retryLocalUntil <= now && state.refreshRetryAt > now) {
      const startedAt = Math.min(now, state.refreshRetryAt - 60000);
      writeRetryStartedAt(WORK_RETRY_KEY, startedAt);
      setRetryStartedAt(startedAt);
      setRetryNow(now);
    }
  }, [state.refreshRetryAt, retryLocalUntil]);

  useEffect(() => {
    if (!serviceUnavailable || retryUntil <= Date.now()) return;
    const timer = window.setInterval(() => setRetryNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [serviceUnavailable, retryUntil]);
  const retryService = async () => {
    if (retryPending.current || state.pending || Date.now() < retryUntil)
      return;
    retryPending.current = true;
    const startedAt = Date.now();
    setRetryNow(startedAt);
    setRetryStartedAt(startedAt);
    writeRetryStartedAt(WORK_RETRY_KEY, startedAt);
    try {
      await farmStore.refresh(workId, { manual: true });
    } finally {
      retryPending.current = false;
    }
  };

  const requested = Math.max(
    0,
    ...goalTargets.map((item) => item.required).filter(Number.isSafeInteger),
  );
  const [count, setCount] = useState(null);
  const completed = view?.completedCycles ?? 0;
  const target =
    count != null
      ? completed + count
      : running && run.workId === workId
        ? run.targetCycles
        : Math.max(completed + 1, requested || completed + 1);
  const refreshed = useRef(null);
  useEffect(() => {
    if (!state.loaded || state.error) {
      refreshed.current = null;
      return;
    }
    if (
      view ||
      running ||
      state.pending ||
      refreshed.current === workId ||
      Date.now() < retryUntil
    )
      return;
    refreshed.current = workId;
    void farmStore.refresh(workId);
  }, [
    farmStore,
    workId,
    view,
    state.loaded,
    state.error,
    state.pending,
    running,
    retryUntil,
  ]);
  const [launchError, setLaunchError] = useState(null);
  const remaining = Math.max(0, target - completed);
  const fullCycleEnergy =
    energy ??
    work.energyCycle?.full ??
    (view
      ? view.tasks.reduce(
          (sum, task) => sum + task.required * task.energyCost,
          0,
        )
      : null);
  const firstCycleEnergy = view
    ? workEnergyRemaining(view, completed + 1)
    : fullCycleEnergy;
  const budgetCycles =
    energyBudget != null &&
    firstCycleEnergy > 0 &&
    fullCycleEnergy > 0 &&
    energyBudget >= firstCycleEnergy
      ? 1 + Math.floor((energyBudget - firstCycleEnergy) / fullCycleEnergy)
      : 0;
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
        maxActions: 30000,
        maxBoosters: 1000,
        maxDollar: view.walletDollar,
        allowPurchase: true,
      });
    } catch {
      return null;
    }
  }, [view, target, completed, energyOnly]);
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
  }, [view, totalEnergy, purchase, knownEnergy, energyOnly]);
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
    });
    if (!ok) setLaunchError("Не удалось начать фарм. Обновите данные.");
  }
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
            {fmt(run.completedCycles ?? completed)} из {fmt(run.targetCycles)}
          </>
        )}
      </LoadingStatus>
      <ProgressBar
        value={
          energyOnly
            ? (run.energySpent ?? 0)
            : (run.completedCycles ?? completed)
        }
        max={energyOnly ? (run.energyBudget ?? 0) : run.targetCycles}
        label={energyOnly ? "Расход энергии" : "Прогресс фарма"}
        valueText={
          energyOnly
            ? `${fmt(run.energySpent ?? 0)} из ${fmt(run.energyBudget ?? 0)} энергии`
            : `${fmt(run.completedCycles ?? completed)} из ${fmt(run.targetCycles)}`
        }
      />
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
      footerStart={
        <>
          <Button onClick={onClose}>Закрыть</Button>
          {serviceUnavailable && (
            <Button
              disabled={state.pending || retrySeconds > 0}
              onClick={() => void retryService()}
            >
              Обновить данные
            </Button>
          )}
        </>
      }
      footer={
        running ? (
          <Button onClick={() => void farmStore.stop()}>Остановить</Button>
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
      optionSelection={{
        value: energyOnly ? "wait" : effectiveOption,
        onChange: setSelectedOption,
        disabled: running,
      }}
      showPurchaseOption={!energyOnly}
      waitOptionTitle={energyOnly ? "Потратить доступную энергию" : undefined}
      footerNote={
        serviceUnavailable ? (
          <Pill variant="warning" size="xs" title={refreshIssue}>
            Не удалось обновить работу
          </Pill>
        ) : view?.boostersStatus === "error" ? (
          <Pill variant="warning" size="xs">
            Дефибрилляторы недоступны
          </Pill>
        ) : (
          ""
        )
      }
      onClose={onClose}
      countControl={{
        value: String(energyOnly ? budgetCycles : Math.max(1, remaining)),
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
      recoveryPlan={knownEnergy ? energyPlan : undefined}
      intro={
        <>
          <WorkStashCard work={work} stash={view?.stash} />
          {refreshIssue && (
            <BaseCard role="alert">
              <CardDescription>{refreshIssue}</CardDescription>
            </BaseCard>
          )}
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
          {launchError && (
            <BaseCard role="alert">
              <CardDescription title={launchError}>
                {launchError}
              </CardDescription>
            </BaseCard>
          )}
        </>
      }
      afterOptions={
        active ? (
          <BaseCard>{activeProgress}</BaseCard>
        ) : running ? (
          <BaseCard className="work-calculator-goal">
            <CardDescription title={run.reason}>
              Фарм идёт · {run.completedCycles ?? completed} /{" "}
              {run.targetCycles}
            </CardDescription>
          </BaseCard>
        ) : null
      }
    />
  );
}
