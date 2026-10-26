// Capture is read-only. The caller persists this checkpoint before suspend().
// These synchronous transitions never interrupt a battle or an in-flight POST.
export function createRaidPriority({
  controller,
  goal,
  auto,
  raid,
  work,
  business,
}) {
  function safe() {
    const state = controller.getSnapshot();
    return !(
      state.pending ||
      state.pendingInvitation ||
      state.needsRefresh ||
      state.error ||
      state.purchase ||
      state.purchaseUncertain ||
      state.medicineOpen ||
      state.battle?.status === "active" ||
      goal.getSnapshot()?.rewardUncertain ||
      !work.canSuspend() ||
      !business.canSuspend() ||
      (raid.getSnapshot().enabled && !raid.canSuspend())
    );
  }
  return {
    capture() {
      if (!safe()) return null;
      const state = controller.getSnapshot();
      return structuredClone({
        bossId: state.boss?.id ?? null,
        goal: goal.exportState(),
        auto: auto.exportState(),
        raidEnabled: Boolean(raid.getSnapshot().enabled),
        businessRunning: business.running(),
        workRunning: work.running(),
      });
    },
    suspend(checkpoint) {
      if (!checkpoint || !safe()) return false;
      // All eligibility checks and mutations run synchronously in one event
      // loop turn, so none of the workers can start between these operations.
      if (checkpoint.raidEnabled && !raid.suspend()) return false;
      if (checkpoint.businessRunning && !business.suspend()) return false;
      if (checkpoint.workRunning && !work.suspend()) return false;
      auto.stop();
      goal.reset();
      return true;
    },
  };
}
