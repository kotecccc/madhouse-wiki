import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import {
  BossBattleDrops,
  BossBattleReceivedDrops,
} from "./BossBattleReference.jsx";
import { BossBattlePanel, BossBattleDetails } from "./BossBattlePanel.jsx";
import { BossBattleGoalPanel } from "./BossBattleGoalPanel.jsx";
import { BossMedicinePanel } from "./BossMedicinePanel.jsx";
import { BossHealingSettings } from "./BossHealingSettings.jsx";
import { isTerminalBossBattle } from "./boss-battle-status.js";
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
  useEffect(() => {
    const unsubscribe = subscribeSession(() => bossBattle.close());
    const timer = window.setInterval(() => {
      if (bossBattle.getSnapshot().boss && readSession().status !== "ready")
        bossBattle.reset();
    }, 1000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      bossBattle.reset();
    };
  }, []);
  useEffect(() => {
    if (!state.visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.visible]);
  const needsDetails = Boolean(
    state.visible &&
    state.battle &&
    !state.pending &&
    !state.battle.detailsLoaded,
  );
  useEffect(() => {
    if (needsDetails) void bossBattle.hydrateDetails();
  }, [needsDetails]);
  if (!state.visible || !state.boss) return null;
  const battle = state.battle;
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
    />
  );
  return (
    <Modal
      title={`Босс «${state.boss.name}»`}
      width="var(--page-max-width)"
      contentVariant="inset"
      onClose={bossBattle.close}
      footer={false}
    >
      <div className="boss-battle-layout">
        <div className="boss-battle-column">
          <BossBattlePanel
            state={state}
            departmentCode={departmentCode}
            startBlocked={Boolean(goal && !bossBattleGoal.canStart())}
            now={Math.max(now, Date.now())}
            onStart={() => void bossBattle.start()}
            auto={{ ...auto, enabled: auto.enabled || state.raid?.enabled }}
            onAttack={() => {
              if (!bossBattleAuto.getSnapshot().enabled)
                void bossBattle.attack();
            }}
            onMedicines={() =>
              state.medicineOpen
                ? bossBattle.closeMedicines()
                : void bossBattle.openMedicines()
            }
          />
          {showNext && (
            <div className="boss-battle-actions">
              {showNext && (
                <Button
                  variant="primary"
                  icon="combat"
                  disabled={
                    auto.enabled ||
                    state.raid?.enabled ||
                    Boolean(state.pending) ||
                    state.needsRefresh ||
                    state.purchaseUncertain ||
                    Boolean(state.purchase) ||
                    Boolean(goal && !goal.canContinue)
                  }
                  title={actionHint || state.notice}
                  onClick={() => void bossBattle.startNextBattle()}
                >
                  {state.pending === "restart"
                    ? "Запуск…"
                    : goal
                      ? "Следующий бой"
                      : "Напасть"}
                </Button>
              )}
            </div>
          )}
          {goalPanel}
          <BossHealingSettings
            key={`healing-${state.boss.id}`}
            state={state}
            onSave={(settings) =>
              settings === null
                ? bossBattle.acknowledgeHealing()
                : bossBattle.configureHealing(settings)
            }
          />
          {state.medicineOpen && (
            <BossMedicinePanel state={state} now={Math.max(now, Date.now())} />
          )}
          {battle?.outcome && (
            <BossBattleReceivedDrops boss={state.boss} battle={battle} />
          )}
          {battle?.status !== "active" && (
            <BossBattleDrops boss={state.boss} battle={battle} />
          )}
        </div>
        <div className="boss-battle-column">
          {battle && <BossBattleDetails boss={state.boss} battle={battle} />}
        </div>
      </div>
    </Modal>
  );
}
