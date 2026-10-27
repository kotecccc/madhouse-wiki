import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { BossBattleReceivedDrops } from "./BossBattleReference.jsx";
import { BossBattlePanel, BossBattleDetails } from "./BossBattlePanel.jsx";
import { BossBattleGoalPanel } from "./BossBattleGoalPanel.jsx";
import { BossHealingSettings } from "./BossHealingSettings.jsx";
import { isTerminalBossBattle } from "./boss-battle-status.js";
import { isBossAutomationWaiting } from "./boss-battle-presentation.js";
import { battleActionHint } from "./boss-battle-controller.js";
import { bossById, departmentById } from "../../../model/knowledge-base.js";
import {
  bossBattle,
  bossBattleAuto,
  bossBattleGoal,
} from "./boss-battle-session.js";
import "./BossBattleDialog.css";

const useBattle = () =>
  useSyncExternalStore(
    bossBattle.subscribe,
    bossBattle.getSnapshot,
    bossBattle.getSnapshot,
  );

export function openBossBattle(boss, openingRequirements) {
  bossBattle.open(boss, {
    refresh: !bossBattleAuto.getSnapshot().enabled,
    openingRequirements,
  });
}

export function BossBattleButton({ boss, size = "md", openingRequirements }) {
  const sessionStatus = useSyncExternalStore(
    subscribeSession,
    () => readSession().status,
    () => "empty",
  );
  if (sessionStatus !== "ready") return null;
  return (
    <Button
      variant="card-action"
      size={size}
      icon="combat"
      title="Открыть ручной бой"
      onClick={() => openBossBattle(boss, openingRequirements)}
      aria-haspopup="dialog"
      aria-label={`Бой: ${boss.name}`}
    >
      Бой
    </Button>
  );
}

export function BossBattleDialog() {
  const state = useBattle();
  const auto = useSyncExternalStore(
    bossBattleAuto.subscribe,
    bossBattleAuto.getSnapshot,
    bossBattleAuto.getSnapshot,
  );
  const goal = useSyncExternalStore(
    bossBattleGoal.subscribe,
    bossBattleGoal.getSnapshot,
    bossBattleGoal.getSnapshot,
  );
  const [now, setNow] = useState(Date.now);
  const [actionsTarget, setActionsTarget] = useState(null);
  useEffect(() => {
    const unsubscribe = subscribeSession(() => bossBattle.close());
    const timer = window.setInterval(() => {
      if (bossBattle.getSnapshot().boss && readSession().status !== "ready")
        bossBattle.reset();
    }, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!state.visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.visible]);
  const automationWaiting = isBossAutomationWaiting(state, auto);
  const needsDetails = Boolean(
    !automationWaiting &&
    state.visible &&
    state.battle &&
    !state.pending &&
    (!state.battle.detailsLoaded ||
      (isTerminalBossBattle(state.battle) &&
        !Number.isFinite(state.battle.completedAt))),
  );
  useEffect(() => {
    if (needsDetails) void bossBattle.hydrateDetails();
  }, [needsDetails]);
  if (!state.visible || !state.boss) return null;
  const battle = state.battle;
  const showBattleDetails = Boolean(battle && !isTerminalBossBattle(battle));
  const automationRunning = Boolean(
    auto.enabled ||
    (state.raid?.enabled &&
      (state.raid.bossId == null ||
        Number(state.raid.bossId) === Number(state.boss.id))),
  );
  const catalogueBoss = Object.values(bossById).find(
    (boss) => Number(boss.numericId ?? boss.apiId) === Number(state.boss.id),
  );
  const departmentCode = departmentById[catalogueBoss?.departmentId]?.code;
  const actionHint = battleActionHint(state);
  const showNext =
    !state.invitationOnly &&
    (goal
      ? goal.status === "active" &&
        ["won", "lost", "expired", "surrendered"].includes(battle?.status)
      : isTerminalBossBattle(battle));
  const queuedStart = state.queuedBattleActions?.some(
    (job) => job.type === "battle.start",
  );
  const goalPanel = (
    <BossBattleGoalPanel
      key={state.boss.id}
      state={state}
      goal={goal}
      auto={auto}
      onStopAuto={bossBattleAuto.stop}
      onStart={bossBattleAuto.start}
      onStartRaid={bossBattleAuto.startRaid}
      onStopRaid={bossBattleAuto.stopRaid}
      actionsTarget={actionsTarget}
      now={now}
    />
  );
  return (
    <Modal
      title={`Босс «${state.boss.name}»`}
      loading={Boolean(state.pending)}
      width="var(--page-max-width)"
      contentVariant="inset"
      onClose={bossBattle.close}
      onRefresh={() => bossBattle.refresh()}
      refreshKey={`boss-${state.boss.id}`}
      footer={<div className="boss-battle-footer" ref={setActionsTarget} />}
    >
      <div
        className={`boss-battle-layout${showBattleDetails ? " boss-battle-layout--battle" : ""}`}
      >
        <div className="boss-battle-column">
          <BossBattlePanel
            state={state}
            departmentCode={departmentCode}
            goal={goal}
            now={Math.max(now, Date.now())}
            auto={auto}
            onAttack={() => {
              if (!bossBattleAuto.getSnapshot().enabled)
                void bossBattle.attack();
            }}
          />
          {showNext && !automationRunning && (
            <div className="boss-battle-actions">
              {showNext && !automationRunning && (
                <Button
                  variant="primary"
                  icon="combat"
                  disabled={auto.enabled || state.raid?.enabled || queuedStart}
                  title={actionHint || state.notice}
                  onClick={() => void bossBattle.startNextBattle()}
                >
                  {queuedStart
                    ? "В очереди"
                    : state.pending === "restart"
                      ? "Запуск…"
                      : goal
                        ? "Следующий бой"
                        : "Напасть"}
                </Button>
              )}
            </div>
          )}
          {!automationWaiting && battle?.outcome && (
            <BossBattleReceivedDrops boss={state.boss} battle={battle} />
          )}
        </div>
        {showBattleDetails && (
          <div className="boss-battle-column boss-battle-details-column">
            <BossBattleDetails
              boss={state.boss}
              battle={battle}
              invitation={automationRunning ? state.healing?.invitation : null}
              invitationNotice={state.healing?.invitationNotice}
              now={Math.max(now, Date.now())}
            />
          </div>
        )}
        <div className="boss-battle-column boss-battle-settings-column">
          {goalPanel}
          {state.healing?.notice &&
            state.healing.notice !==
              "Результат удара проверяется. Автоматического повтора не будет." && (
              <ErrorToast message={state.healing.notice} />
            )}
          <BossHealingSettings
            key={`healing-${state.boss.id}`}
            state={state}
            collapsed={auto.enabled || Boolean(state.raid?.enabled)}
            onSave={(settings) =>
              settings === null
                ? bossBattle.acknowledgeHealing()
                : bossBattle.configureHealing(settings)
            }
          />
        </div>
      </div>
    </Modal>
  );
}
