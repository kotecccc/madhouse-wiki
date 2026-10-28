import { battleRetryAfter } from "./battle-preflight-error.mjs";

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
    dedupeKey: (args) => JSON.stringify(args.settings),
    async execute(job, { canDispatch }) {
      if (started(job)) {
        if (entry.pendingAutomation?.id === job.id) clearMarker();
        return { status: "completed" };
      }
      try {
        let state = entry.controller.getSnapshot();
        if (state.boss?.id !== job.args.settings.bossId) {
          if (state.battle?.status === "active" || state.pendingInvitation)
            return { status: "retry", reason: "Ожидаем другие действия." };
          const boss = await getBoss(job.args.settings.bossId);
          if (!boss) return { status: "failed", reason: "unknown_boss" };
          await entry.controller.open(boss);
          const opening = entry.controller.getSnapshot();
          if (opening.needsRefresh || opening.error)
            return {
              status: "retry",
              reason: "Ожидаем игру.",
              ...battleRetryAfter(opening),
            };
        }
        if (!(await refresh()))
          return {
            status: "retry",
            reason: "Ожидаем игру.",
            ...battleRetryAfter(entry.controller.getSnapshot()),
          };
        state = entry.controller.getSnapshot();
        if (
          state.boss?.id !== job.args.settings.bossId ||
          state.pending ||
          state.pendingInvitation ||
          state.purchase ||
          state.purchaseUncertain ||
          state.medicineOpen ||
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
            : entry.auto.start({ queueId: job.id });
        if (!ok) {
          discardUnstarted(job);
          return { status: "retry", reason: "Ожидаем другие действия." };
        }
        clearMarker();
        return { status: "completed" };
      } catch (error) {
        if (started(job)) return { status: "completed" };
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
