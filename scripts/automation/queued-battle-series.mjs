import {
  battleRetryAfter,
  terminalBattlePreflight,
} from "./battle-preflight-error.mjs";
import { validateHealingSettings } from "./battle-assistant.mjs";

// Queue starts an existing actor once; it never replays the actor's game actions.
export function queuedBattleSeriesAdapter({
  entry,
  mode,
  getBoss,
  refresh,
  configure,
  matches,
  save,
}) {
  const actor = () => (mode === "raid" ? entry.raidWorker : entry.auto);
  const started = (job) =>
    actor().getSnapshot().queueId === job.id ||
    (actor().getSnapshot().startReceipts ?? []).includes(job.id);
  function clearMarker() {
    entry.pendingAutomation = null;
    save(entry);
    if (entry.storageFailed) throw new Error("automation_storage_unavailable");
  }
  function discardUnstarted(job) {
    if (entry.pendingAutomation?.id !== job.id) return;
    if (entry.pendingAutomation.createdGoal)
      entry.goal.stop({ clearProgress: true });
    clearMarker();
  }
  async function reconcile(job) {
    if (started(job)) {
      if (entry.pendingAutomation?.id === job.id) clearMarker();
      return { status: "completed" };
    }
    if (
      actor().getSnapshot().queueId ||
      actor().getSnapshot().enabled ||
      entry.pendingAutomation?.id !== job.id
    )
      return { status: "uncertain", reason: "Проверяем результат." };
    discardUnstarted(job);
    return { status: "retry" };
  }
  return {
    validate(args) {
      const s = args?.settings;
      if (
        (args?.singleBattleId != null &&
          (mode !== "auto" ||
            typeof args.singleBattleId !== "string" ||
            !/^[A-Za-z0-9_-]{1,120}$/.test(args.singleBattleId))) ||
        (args?.progressionTarget != null && args.progressionTarget !== true) ||
        (args?.progressionTarget === true &&
          (s?.kind !== "battles" ||
            s?.countWins !== true ||
            args.singleBattleId != null)) ||
        !s ||
        !Number.isSafeInteger(s.bossId) ||
        s.bossId <= 0 ||
        !["battles", "business_items", "drops"].includes(s.kind) ||
        (s.kind !== "drops" &&
          (!Number.isSafeInteger(s.targetCount) || s.targetCount <= 0)) ||
        ![null, 1, 2, 4].includes(s.durationHours ?? null) ||
        (s.maxAttempts != null &&
          (!Number.isSafeInteger(s.maxAttempts) || s.maxAttempts <= 0)) ||
        (s.kind === "battles" &&
          s.maxAttempts != null &&
          s.maxAttempts < s.targetCount) ||
        (s.kind === "business_items" &&
          (typeof s.itemKey !== "string" || s.itemKey.length > 100)) ||
        (s.kind === "drops" &&
          (!["all", "selected"].includes(s.selection) ||
            (s.selection === "selected" &&
              (!Array.isArray(s.itemKeys) ||
                !s.itemKeys.length ||
                s.itemKeys.length > 200 ||
                s.itemKeys.some(
                  (key) => typeof key !== "string" || key.length > 100,
                )))))
      )
        throw new Error("invalid_automation_goal");
      return {
        ...(args.healingSettings != null
          ? { healingSettings: validateHealingSettings(args.healingSettings) }
          : {}),
        ...(args.singleBattleId ? { singleBattleId: args.singleBattleId } : {}),
        ...(args.progressionTarget ? { progressionTarget: true } : {}),
        settings: {
          bossId: s.bossId,
          kind: s.kind,
          ...(s.kind !== "drops" ? { targetCount: s.targetCount } : {}),
          ...(s.kind === "battles" ? { countWins: s.countWins === true } : {}),
          ...(s.kind === "business_items" ? { itemKey: s.itemKey } : {}),
          ...(s.kind === "drops"
            ? {
                selection: s.selection,
                ...(s.selection === "selected"
                  ? { itemKeys: [...s.itemKeys] }
                  : {}),
              }
            : {}),
          durationHours: s.durationHours ?? null,
          maxAttempts: s.maxAttempts ?? null,
        },
      };
    },
    dedupeKey: (args) =>
      mode === "raid"
        ? `boss:${args.settings.bossId}`
        : JSON.stringify([
            args.settings,
            args.singleBattleId,
            args.progressionTarget,
            args.healingSettings,
          ]),
    dedupeConflict: (next, existing) =>
      mode === "raid" && JSON.stringify(next) !== JSON.stringify(existing),
    async execute(job, { canDispatch }) {
      if (started(job)) {
        if (entry.pendingAutomation?.id === job.id) clearMarker();
        return { status: "completed" };
      }
      try {
        if (job.args.progressionTarget) {
          const target = await entry.floorActions.plan({
            bossId: job.args.settings.bossId,
          });
          if (target.status === "changed")
            return { status: "failed", reason: "progression_target_changed" };
          if (target.status !== "ready")
            return { status: "retry", reason: "Проверяем актуальную задачу." };
          if (
            target.kind !== "boss" ||
            target.apiId !== job.args.settings.bossId ||
            target.required - target.current !== job.args.settings.targetCount
          )
            return { status: "failed", reason: "progression_target_changed" };
        }
        let state = entry.controller.getSnapshot();
        let opened = false;
        if (state.boss?.id !== job.args.settings.bossId) {
          if (state.battle?.status === "active" || state.pendingInvitation)
            return { status: "retry", reason: "Ожидаем другие действия." };
          const boss = await getBoss(job.args.settings.bossId);
          if (!boss) return { status: "failed", reason: "unknown_boss" };
          await entry.controller.open(boss, { discover: true });
          const opening = entry.controller.getSnapshot();
          if (opening.needsRefresh || opening.error)
            return (
              terminalBattlePreflight(opening.errorStatus) ?? {
                status: "retry",
                reason: "Ожидаем игру.",
                ...battleRetryAfter(opening),
              }
            );
          if (opening.boss?.id !== job.args.settings.bossId)
            return { status: "retry", reason: "Ожидаем другие действия." };
          opened = true;
        }
        if (!(await refresh({ alreadyRefreshed: opened }))) {
          const current = entry.controller.getSnapshot();
          return (
            terminalBattlePreflight(current.errorStatus) ?? {
              status: "retry",
              reason: "Ожидаем игру.",
              ...battleRetryAfter(current),
            }
          );
        }
        state = entry.controller.getSnapshot();
        if (
          job.args.singleBattleId &&
          (state.battle?.id !== job.args.singleBattleId ||
            state.battle?.status !== "active")
        )
          return { status: "failed", reason: "battle_no_longer_active" };
        if (
          state.boss?.id !== job.args.settings.bossId ||
          state.pending ||
          state.pendingInvitation ||
          state.purchase ||
          state.purchaseUncertain ||
          state.medicineOpen ||
          (job.args.healingSettings &&
            entry.assistant.projection?.().uncertain) ||
          (mode === "raid" && state.battle?.status === "active")
        )
          return { status: "retry", reason: "Ожидаем другие действия." };
        if (
          entry.goal.getSnapshot()?.status === "active" &&
          !matches(job.args.settings, state)
        )
          return { status: "retry", reason: "Ожидаем другую цель." };
        if (!canDispatch()) return { status: "retry" };
        entry.pendingAutomation = {
          id: job.id,
          createdGoal:
            entry.pendingAutomation?.id === job.id
              ? entry.pendingAutomation.createdGoal
              : entry.goal.getSnapshot()?.status !== "active",
        };
        save(entry);
        if (entry.storageFailed)
          throw new Error("automation_storage_unavailable");
        configure(job.args.settings, state);
        if (job.args.healingSettings)
          entry.assistant.configure(job.args.healingSettings);
        if (entry.storageFailed)
          throw new Error("automation_storage_unavailable");
        if (
          mode === "auto" &&
          state.invitationOnly &&
          state.battle?.status !== "active" &&
          !entry.controller.allowSoloContinuation({ allowRecovery: true })
        )
          throw new Error("automation_start_unavailable");
        if (
          mode === "raid" &&
          !entry.assistant.begin(
            `${state.boss.id}:${entry.goal.getSnapshot()?.startedAt ?? "single"}`,
          )
        )
          throw new Error("raid_safety_unconfirmed");
        const ok =
          mode === "raid"
            ? entry.raidWorker.start(state.boss.id, { queueId: job.id })
            : entry.auto.start({
                queueId: job.id,
                singleBattle: Boolean(job.args.singleBattleId),
              });
        if (!ok) {
          discardUnstarted(job);
          return { status: "retry", reason: "Ожидаем другие действия." };
        }
        clearMarker();
        return { status: "completed" };
      } catch (error) {
        if (started(job)) return { status: "completed" };
        const terminal = terminalBattlePreflight(error?.status);
        if (terminal && entry.pendingAutomation?.id !== job.id) return terminal;
        if (error instanceof TypeError || error instanceof RangeError) {
          discardUnstarted(job);
          return { status: "failed", reason: "invalid_automation_goal" };
        }
        discardUnstarted(job);
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          ...battleRetryAfter({ errorRetryAfterMs: error?.retryAfterMs }),
        };
      }
    },
    reconcile,
  };
}
