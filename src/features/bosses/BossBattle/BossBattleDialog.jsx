import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { ProgressButton } from "../../../components/ui/ProgressButton/ProgressButton.jsx";
import { fmt } from "../../../lib/format.js";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { BossBattlePanel, BossBattleDetails } from "./BossBattlePanel.jsx";
import { BossBattleGoalPanel } from "./BossBattleGoalPanel.jsx";
import {
  BossHealingSettings,
  normalizeHealingDraft,
} from "./BossHealingSettings.jsx";
import { BossMedicinePanel } from "./BossMedicinePanel.jsx";
import { isTerminalBossBattle } from "./boss-battle-status.js";
import {
  canQueueBossBattleStart,
  healingErrorNotice,
  isBossAutomationWaiting,
} from "./boss-battle-presentation.js";
import { battleActionHint } from "./boss-battle-controller.js";
import {
  bossBattleReference,
  bossBattleRewardText,
} from "./boss-battle-reference.js";
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

const saveHealingSettings = (settings) =>
  settings === null
    ? bossBattle.acknowledgeHealing()
    : bossBattle.configureHealing(settings);

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

export function BossBattleDialog({ actionsTarget, attackTarget }) {
  const battleState = useBattle();
  const preview = Boolean(battleState.previewBoss);
  const otherActiveBattle = preview && battleState.battle?.status === "active";
  const state = preview
    ? {
        ...battleState,
        boss: battleState.previewBoss,
        battle: null,
        pending: null,
        medicineOpen: false,
        notice: otherActiveBattle
          ? null
          : battleState.battle && !isTerminalBossBattle(battleState.battle)
            ? `Сначала завершите текущий бой с боссом «${battleState.boss.name}».`
            : battleState.error ||
              (battleState.needsRefresh
                ? "Не удалось проверить предыдущий бой. Потяните вниз, чтобы повторить проверку."
                : "Не удалось переключиться на этого босса. Потяните вниз, чтобы повторить проверку."),
      }
    : battleState;
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
  const [queueNotice, setQueueNotice] = useState(null);
  const [healingDraft, setHealingDraft] = useState(null);
  const [rewardNotice, setRewardNotice] = useState(null);
  const shownRewards = useRef(new Set());
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
  const rewardBattle =
    !preview &&
    !automationWaiting &&
    state.visible &&
    state.battle?.outcome &&
    state.battle?.rewardKnown &&
    state.battle?.id
      ? state.battle
      : null;
  const rewardKey = rewardBattle
    ? `${state.boss?.id}:${rewardBattle.id}`
    : null;
  const rewardText = rewardBattle
    ? bossBattleRewardText(state.boss?.reference, rewardBattle)
    : null;
  useEffect(() => {
    if (!rewardKey || shownRewards.current.has(rewardKey)) return;
    shownRewards.current.add(rewardKey);
    setRewardNotice({ key: rewardKey, text: rewardText });
  }, [rewardKey, rewardText]);
  if (!state.visible || !state.boss) return null;
  const battle = state.battle;
  const battlePath =
    battle?.id && /^[A-Za-z0-9_-]+$/.test(String(battle.id))
      ? `/battle/${battle.id}`
      : null;
  const pageUrl =
    battlePath &&
    (battle.status === "active" ||
      (typeof window !== "undefined" &&
        window.location.pathname === battlePath))
      ? battlePath
      : `/boss/${state.boss.id}`;
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
  const displayState = catalogueBoss
    ? {
        ...state,
        boss: {
          ...state.boss,
          reference: {
            ...bossBattleReference(catalogueBoss),
            ...state.boss.reference,
          },
        },
      }
    : state;
  const departmentCode = departmentById[catalogueBoss?.departmentId]?.code;
  const actionHint = battleActionHint(state);
  const queuedStart = state.queuedBattleActions?.some(
    (job) => job.type === "battle.start",
  );
  const canAttack = canQueueBossBattleStart(state, {
    preview,
    automationRunning,
  });
  const queuedHealing =
    healingDraft?.bossId === state.boss.id
      ? healingDraft.settings
      : normalizeHealingDraft(state.healing?.settings);
  const queueInsteadOfStart = Boolean(
    battleState.battle?.status === "active" ||
    auto.enabled ||
    auto.userPaused ||
    battleState.raid?.enabled ||
    battleState.raid?.userPaused,
  );
  const startQueuedSeries = (start, label) => async (settings) => {
    const accepted = await start(
      settings,
      preview ? { healingSettings: queuedHealing } : undefined,
    );
    if (accepted && queueInsteadOfStart)
      setQueueNotice(`${label} добавлен в очередь.`);
    return accepted;
  };
  const goalPanel = (
    <BossBattleGoalPanel
      key={state.boss.id}
      state={displayState}
      goal={goal}
      auto={preview ? { enabled: false } : auto}
      raid={preview ? { enabled: false } : state.raid}
      onStopAuto={bossBattleAuto.stop}
      onStart={startQueuedSeries(bossBattleAuto.start, "Автобой")}
      onStartRaid={startQueuedSeries(bossBattleAuto.startRaid, "Рейд")}
      onStopRaid={bossBattleAuto.stopRaid}
      actionsTarget={actionsTarget}
      menuActions
      queueInsteadOfStart={queueInsteadOfStart}
      hideSettings={battle?.status === "active"}
      now={now}
    />
  );
  return (
    <Modal
      title={`Босс «${state.boss.name}»`}
      hideHeader
      pageKind="boss"
      pageUrl={pageUrl}
      loading={Boolean(state.pending)}
      width="var(--page-max-width)"
      contentVariant="inset"
      onClose={bossBattle.close}
      onRefresh={
        preview
          ? () => bossBattle.open(battleState.previewBoss)
          : () => bossBattle.refresh()
      }
      refreshKey={`boss-${state.boss.id}`}
      footer={false}
    >
      {attackTarget &&
        createPortal(
          otherActiveBattle ? (
            <ProgressButton
              icon="boss"
              imageSrc={
                battleState.boss.reference?.image ||
                Object.values(bossById).find(
                  (boss) =>
                    Number(boss.numericId ?? boss.apiId) ===
                    Number(battleState.boss.id),
                )?.image
              }
              label={`Бой: ${battleState.boss.name}. Идёт бой`}
              value={battleState.battle.bossHealth}
              max={battleState.battle.bossMaxHealth}
              valueText={
                Number.isFinite(battleState.battle.bossHealth) &&
                Number.isFinite(battleState.battle.bossMaxHealth) &&
                battleState.battle.bossMaxHealth > 0
                  ? `HP босса: ${fmt(battleState.battle.bossHealth)} из ${fmt(battleState.battle.bossMaxHealth)}`
                  : "HP босса пока неизвестно"
              }
              animateLoss
              animationKey={battleState.battle.id}
              onClick={() => bossBattle.showCurrentBattle()}
            />
          ) : (
            <Button
              variant="nav-tab"
              icon="combat"
              iconSize="large"
              aria-label="Напасть"
              disabled={!canAttack}
              title={
                queuedStart ? "Бой уже в очереди" : actionHint || state.notice
              }
              onClick={() =>
                void bossBattle.start().then((accepted) => {
                  if (accepted) setQueueNotice("Бой добавлен в очередь.");
                })
              }
            >
              Напасть
            </Button>
          ),
          attackTarget,
        )}
      <div
        className={`boss-battle-layout${showBattleDetails ? " boss-battle-layout--battle" : ""}`}
      >
        <div className="boss-battle-column">
          <BossBattlePanel
            state={displayState}
            departmentCode={departmentCode}
            goal={goal}
            now={Math.max(now, Date.now())}
            auto={preview ? { enabled: false } : auto}
            onFinishBattle={() =>
              void bossBattleAuto
                .finishBattle(state.boss.id, state.battle.id)
                .then((accepted) => {
                  if (accepted) setQueueNotice("Бой добавлен в очередь.");
                })
            }
            onAttack={() => {
              if (!bossBattleAuto.getSnapshot().enabled)
                void bossBattle.attack().then((accepted) => {
                  if (accepted) setQueueNotice("Удар добавлен в очередь.");
                });
            }}
          />
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
        {(!preview || otherActiveBattle) && (
          <div className="boss-battle-column boss-battle-settings-column">
            {goalPanel}
            {!preview && (
              <ErrorToast message={healingErrorNotice(state.healing?.notice)} />
            )}
            <BossHealingSettings
              key={`healing-${state.boss.id}-${preview}`}
              state={state}
              onDraftChange={
                preview
                  ? (settings) =>
                      setHealingDraft({ bossId: state.boss.id, settings })
                  : undefined
              }
              collapsed={auto.enabled || Boolean(state.raid?.enabled)}
              onSave={saveHealingSettings}
            />
            {!preview && state.medicineOpen && (
              <BossMedicinePanel
                state={state}
                now={Math.max(now, Date.now())}
                onClose={() => bossBattle.closeMedicines()}
              />
            )}
          </div>
        )}
      </div>
      {queueNotice && (
        <Toast
          floating
          success
          title="В очереди"
          onDismiss={() => setQueueNotice(null)}
        >
          {queueNotice}
        </Toast>
      )}
      {rewardNotice && (
        <Toast
          key={rewardNotice.key}
          floating
          success
          title="Полученный дроп"
          onDismiss={() => setRewardNotice(null)}
        >
          {rewardNotice.text}
        </Toast>
      )}
    </Modal>
  );
}
