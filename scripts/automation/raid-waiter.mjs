const INTERVAL_MS = 10000;

// The account heartbeat owns polling. Intent/checkpoints are persisted by onChange.
export function createRaidWaiter({
  saved,
  now = Date.now,
  state,
  goal,
  auto,
  available,
  lock,
  unlock,
  refresh,
  invitations,
  accept,
  onChange,
}) {
  let value = saved ?? { enabled: false, status: "stopped", bossId: null };
  let running = false;
  let ready = !saved?.enabled;
  const publish = (patch) => {
    value = { ...value, ...patch };
    onChange();
  };
  const stop = (status = "stopped", notice = "Рейд остановлен.") => {
    publish({ enabled: false, status, notice, nextCheckAt: null });
    auto.stop();
  };
  const uncertain = () => {
    const current = state();
    return Boolean(
      current.pendingInvitation ||
      current.needsRefresh ||
      current.pending ||
      current.error ||
      current.purchase ||
      current.purchaseUncertain ||
      current.medicineOpen,
    );
  };
  return {
    getSnapshot: () => value,
    start(bossId) {
      if (running || value.enabled || uncertain()) return false;
      const current = state();
      if (current.battle?.status === "active") return false;
      ready = true;
      publish({
        enabled: true,
        status: "waiting",
        bossId,
        nextCheckAt: now(),
        notice: "Ждём приглашения на выбранного босса.",
      });
      return true;
    },
    stop,
    resume() {
      if (!value.enabled) return;
      if (uncertain() || value.status === "joining") {
        stop(
          "paused",
          "Состояние вступления не подтверждено. Проверьте бой перед новым запуском.",
        );
        return;
      }
      ready = true;
      publish({ nextCheckAt: now() });
    },
    async tick() {
      if (!ready || !value.enabled || running) return;
      const currentGoal = goal.getSnapshot();
      if (
        !currentGoal ||
        currentGoal.status !== "active" ||
        currentGoal.rewardUncertain
      ) {
        stop(
          currentGoal?.status ?? "stopped",
          "Рейд завершён по настройкам автобоя.",
        );
        return;
      }
      if (!available()) {
        stop(
          "paused",
          "Рейд остановлен: состояние игры или хранилища недоступно.",
        );
        return;
      }
      if (auto.getSnapshot().enabled) return;
      if (!lock()) return;
      running = true;
      try {
        if (uncertain()) throw new Error("uncertain");
        const current = state();
        if (current.boss?.id !== value.bossId) throw new Error("boss_changed");
        if (current.battle?.status === "active") {
          // Never restart a halted strike engine or adopt an unrelated fight.
          throw new Error("active_battle");
        }
        if (now() < (value.nextCheckAt ?? 0)) return;
        publish({
          status: "waiting",
          nextCheckAt: now() + INTERVAL_MS,
          notice: "Ждём приглашения на выбранного босса.",
        });
        await refresh();
        if (!value.enabled) return;
        const invitation = invitations().find(
          (item) =>
            item.bossId === value.bossId &&
            item.available &&
            item.expiresAt > now(),
        );
        if (!invitation) return;
        publish({
          status: "joining",
          notice: "Вступаем в рейд по приглашению…",
        });
        await accept(invitation.invitationId, () => value.enabled);
        if (!value.enabled) return;
        const joined = state();
        if (
          uncertain() ||
          !joined.invitationOnly ||
          joined.battle?.id !== invitation.battleId ||
          joined.battle?.status !== "active"
        )
          throw new Error("join_unconfirmed");
        publish({
          status: "fighting",
          notice: "Рейд идёт. После боя ждём следующее приглашение.",
        });
        if (!auto.start()) throw new Error("attack_unavailable");
      } catch {
        if (value.enabled)
          stop(
            "paused",
            "Рейд приостановлен. Проверьте состояние боя; повторного вступления не будет.",
          );
      } finally {
        running = false;
        unlock();
      }
    },
  };
}
