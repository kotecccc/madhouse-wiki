import { forecastQuota } from "./quota-forecast.mjs";
import { medicinePurchaseQuote } from "../../src/features/bosses/BossBattle/boss-medicines.js";

const types = ["heal_10", "heal_full"];
const currencies = ["gold", "dollar", "pills"];
const counts = () => ({ heal_10: 0, heal_full: 0 });
const money = () => ({ gold: 0, dollar: 0, pills: 0 });
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
export function defaultHealingSettings() {
  return {
    enabled: false,
    autoBuy: false,
    items: {
      heal_10: { enabled: false, limit: 0, currency: "gold" },
      heal_full: { enabled: false, limit: 0, currency: "pills" },
    },
    budgets: money(),
  };
}
export function validateHealingSettings(input) {
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    typeof input.autoBuy !== "boolean"
  )
    throw new Error("invalid_healing_settings");
  const result = defaultHealingSettings();
  result.enabled = input.enabled;
  result.autoBuy = input.autoBuy;
  if (input.budgetMode === "item_limits") result.budgetMode = "item_limits";
  for (const type of types) {
    const item = input.items?.[type];
    if (
      !item ||
      typeof item.enabled !== "boolean" ||
      !integer(item.limit) ||
      item.limit > 10000 ||
      !currencies.includes(item.currency)
    )
      throw new Error("invalid_healing_settings");
    result.items[type] = {
      enabled: item.enabled,
      limit: item.limit,
      currency: item.currency,
    };
  }
  for (const currency of currencies) {
    if (!integer(input.budgets?.[currency]))
      throw new Error("invalid_healing_budget");
    result.budgets[currency] = input.budgets[currency];
  }
  return result;
}

// The user-selected policy uses the API's declared damageMax, without assuming
// a critical multiplier or subtracting temporary damage-reduction bonuses.
export function chooseBattleAction(state, healing, bound) {
  const b = state.battle;
  if (!b || b.status !== "active")
    return { kind: "stop", notice: "Бой не активен." };
  if (!Number.isSafeInteger(bound) || bound < 0)
    return {
      kind: "stop",
      notice: "Ждём корректный damageMax из API.",
    };
  if (b.playerHealth > bound) return { kind: "attack" };
  if (b.playerMaxHealth <= bound)
    return {
      kind: "stop",
      notice: "Даже полного здоровья недостаточно для безопасного удара.",
    };
  if (!healing.settings.enabled)
    return {
      kind: "stop",
      notice: "Ждём лечения перед следующим ударом. Автолечение выключено.",
    };
  if (!state.medicines) return { kind: "stock" };
  const purchases = [];
  for (const type of types) {
    const config = healing.settings.items[type];
    if (!config.enabled || healing.used[type] >= config.limit) continue;
    const restored =
      type === "heal_full"
        ? b.playerMaxHealth
        : Math.floor(b.playerMaxHealth / 10);
    if (Math.min(b.playerMaxHealth, b.playerHealth + restored) <= bound)
      continue;
    const item = state.medicines.find((item) => item.type === type);
    if (item?.quantity > 0) return { kind: "heal", type };
    if (!healing.settings.autoBuy || item?.quantity !== 0) continue;
    const quote = medicinePurchaseQuote(
      state.medicines,
      type,
      config.currency,
      1,
    );
    if (
      quote &&
      (healing.settings.budgetMode === "item_limits" ||
        quote.total <=
          healing.settings.budgets[config.currency] -
            healing.spent[config.currency])
    )
      purchases.push({ kind: "buy", type, quote });
  }
  if (purchases.length) return purchases[0];
  return {
    kind: "stop",
    notice: "Ждём лечения: проверьте лимиты, запас и бюджет аптечек.",
  };
}

export function invitationDecision(battle, { initial = false } = {}) {
  if (!battle || battle.status !== "active") return "Бой не активен.";
  if (
    !initial &&
    (!battle.quotaFresh ||
      battle.dropDamageRequired == null ||
      battle.totalDamage == null)
  )
    return "Приглашения отложены — норма урона не подтверждена.";
  if (!initial && battle.totalDamage < battle.dropDamageRequired)
    return battle.bossHealth < battle.dropDamageRequired - battle.totalDamage
      ? "Приглашения отложены — HP босса меньше остатка нормы."
      : "Приглашения отложены — набираем норму урона.";
  if (battle.maxParticipants == null || battle.participantCount == null)
    return "Приглашения отложены — число свободных мест неизвестно.";
  if (battle.participantCount >= battle.maxParticipants)
    return "В бою нет свободных мест.";
  return null;
}

export function createBattleAssistant({
  controller,
  saved,
  now = Date.now,
  random = Math.random,
  onChange = () => {},
  available = () => true,
  priorityActive = () => false,
  readAvailable = available,
  refreshAvailability = async () => {},
}) {
  let record = saved
    ? structuredClone(saved)
    : {
        profiles: {},
        battles: {},
        runKey: null,
        spent: money(),
        pending: null,
      };
  record.profiles ??= {};
  record.battles ??= {};
  record.spent ??= money();
  record.queuedReceipts ??= [];
  // Older records stored healing preferences per boss. Keep the active boss's
  // preferences when possible; otherwise migrate the first saved profile.
  if (!record.healingSettings) {
    const bossId = controller.getSnapshot().boss?.id;
    const legacy = record.profiles[bossId] ?? Object.values(record.profiles)[0];
    if (legacy) record.healingSettings = validateHealingSettings(legacy);
  }
  delete record.profiles;
  let notice = record.pending
    ? "Предыдущее действие не подтверждено. Автоматического повтора не будет."
    : null;
  let invitationNotice = null;
  let stopped = false;
  let generation = 0;
  const settings = () => record.healingSettings ?? defaultHealingSettings();
  const hasProfile = () => Boolean(record.healingSettings);
  function damageBound() {
    const state = controller.getSnapshot();
    return state.damageLimit?.bossId === state.boss?.id
      ? state.damageLimit.value
      : null;
  }
  function battleRecord() {
    const id = controller.getSnapshot().battle?.id;
    if (!id) return { used: counts(), inviteAt: null };
    return (record.battles[id] ??= {
      used: counts(),
      inviteAt: null,
      inviteBlocked: false,
      inviteAttempted: false,
      invitedCount: 0,
    });
  }
  function publish() {
    onChange();
  }
  function projection() {
    return {
      settings: structuredClone(settings()),
      used: { ...battleRecord().used },
      spent: { ...record.spent },
      notice: notice ?? record.waiting?.notice ?? null,
      invitationNotice,
      invitation: {
        nextAt: battleRecord().inviteAt,
        attempted: battleRecord().inviteAttempted === true,
        invitedCount: battleRecord().invitedCount ?? 0,
        blocked: battleRecord().inviteBlocked === true,
      },
      uncertain: Boolean(record.pending),
      forecast: forecastQuota(
        controller.getSnapshot().battle,
        battleRecord().samples,
        now(),
      ),
    };
  }
  function stop(message) {
    notice = message;
    publish();
    return { kind: "stop", notice };
  }
  function wait(message, delay = 30000) {
    notice = message;
    record.waiting = { notice: message, retryAt: now() + delay };
    publish();
    return { kind: "wait", retryAt: record.waiting.retryAt };
  }
  async function recover() {
    if (stopped || !readAvailable()) return false;
    const recoveryGeneration = generation;
    await refreshAvailability();
    if (stopped || !readAvailable() || recoveryGeneration !== generation)
      return false;
    if (record.pending) {
      const pending = record.pending;
      await controller.refresh(
        pending.kind === "start" ? { discover: true } : undefined,
      );
      if (stopped || recoveryGeneration !== generation || !readAvailable())
        return false;
      const current = controller.getSnapshot();
      const battle = current.battle;
      const beforeDamage =
        pending.beforeDamage ??
        record.battles[pending.battleId]?.samples?.at(-1)?.totalDamage;
      const confirmed =
        pending.kind === "start"
          ? !current.needsRefresh &&
            !current.error &&
            current.boss?.id === pending.bossId &&
            battle?.status === "active" &&
            Boolean(battle.id) &&
            battle.id !== pending.beforeBattleId
          : pending.kind === "invite" &&
              !pending.queueId &&
              !current.needsRefresh &&
              !current.error &&
              battle?.id === pending.battleId &&
              ["won", "lost", "expired", "surrendered"].includes(
                battle.status,
              ) &&
              Boolean(record.battles[pending.battleId])
            ? (record.battles[pending.battleId].inviteBlocked = true)
            : pending.kind === "attack" &&
              !current.needsRefresh &&
              !current.error &&
              battle?.id &&
              (battle.id !== pending.battleId ||
                (Number.isFinite(beforeDamage) &&
                  Number.isFinite(battle.totalDamage) &&
                  battle.totalDamage > beforeDamage));
      if (!confirmed) return false;
      complete();
    }
    const beforeRead = controller.getSnapshot();
    let refreshedBattle = false;
    if (
      beforeRead.battle?.status === "active" &&
      (beforeRead.needsRefresh ||
        beforeRead.error ||
        (beforeRead.battle.expiresAt != null &&
          beforeRead.battle.expiresAt <= now()))
    ) {
      await controller.refresh();
      refreshedBattle = true;
      if (
        controller.getSnapshot().needsRefresh ||
        controller.getSnapshot().error
      )
        return false;
    }
    if (controller.getSnapshot().battle?.status === "active")
      await controller.loadMedicines();
    else if (!refreshedBattle) await controller.refresh();
    if (
      controller.getSnapshot().needsRefresh ||
      stopped ||
      !readAvailable() ||
      recoveryGeneration !== generation
    )
      return false;
    await controller.refreshDamageLimit();
    const recovered = !controller.getSnapshot().needsRefresh;
    if (
      recovered &&
      !stopped &&
      readAvailable() &&
      recoveryGeneration === generation
    ) {
      record.waiting = null;
      notice = null;
      publish();
    }
    return recovered;
  }
  function configure(input) {
    record.healingSettings = validateHealingSettings(input);
    publish();
  }
  function begin(key) {
    // A resumed/paused run keeps its budget. A new confirmed goal is a new run.
    stopped = false;
    generation++;
    if (record.runKey !== key && !record.pending) {
      record.runKey = key;
      record.spent = money();
    }
    notice = null;
    publish();
    return true;
  }
  function reserve(operation, automatic = true) {
    if (record.pending || (automatic && stopped) || !available())
      throw new Error("battle_assistant_stopped");
    record.pending = {
      ...operation,
      battleId: controller.getSnapshot().battle?.id ?? null,
      ...(operation.kind === "attack"
        ? { beforeDamage: controller.getSnapshot().battle?.totalDamage ?? null }
        : {}),
    };
    publish(); // Durable account write occurs before the controller sends POST.
  }
  function complete() {
    record.pending = null;
    publish();
  }
  function allowed() {
    return !stopped && available();
  }
  async function use(
    type,
    automatic = false,
    { queueId, beforeReserve = () => true } = {},
  ) {
    if (!types.includes(type)) throw new Error("invalid_medicine_type");
    const actionGeneration = generation;
    const config = settings();
    const ledger = battleRecord();
    if (
      (automatic || hasProfile()) &&
      (!config.items[type]?.enabled ||
        ledger.used[type] >= config.items[type].limit)
    )
      return stop("Лимит этой аптечки исчерпан.");
    const result = await controller.useMedicine(type, {
      automatic,
      queued: Boolean(queueId),
      allowed: (operation, before) => {
        if (automatic && (stopped || generation !== actionGeneration))
          return false;
        const latest = settings();
        if (
          (automatic || hasProfile()) &&
          (!latest.items[type]?.enabled ||
            ledger.used[type] >= latest.items[type].limit)
        )
          return false;
        if (automatic && !latest.enabled) return false;
        if (
          automatic &&
          chooseBattleAction(
            { ...controller.getSnapshot(), ...before },
            projection(),
            damageBound(),
          ).type !== type
        )
          return false;
        if (!beforeReserve(operation, before)) return false;
        reserve(
          {
            kind: "heal",
            type,
            ...operation,
            ...(queueId
              ? {
                  queueId,
                  beforeQuantity:
                    before.medicines?.find((item) => item.type === type)
                      ?.quantity ?? null,
                }
              : {}),
          },
          automatic,
        );
        return true;
      },
    });
    if (result?.confirmed === true) {
      ledger.used[type]++;
      if (queueId)
        record.queuedReceipts = [...record.queuedReceipts.slice(-127), queueId];
      complete();
      return { kind: "heal" };
    }
    return wait(
      "Применение аптечки не подтверждено. Проверьте бой; автоматического повтора не будет.",
    );
  }
  async function buy(
    quote,
    automatic = false,
    { queueId, beforeReserve = () => true } = {},
  ) {
    if (!quote) return stop("Цена аптечки неизвестна.");
    const actionGeneration = generation;
    const result = await controller.buyMedicine({
      automatic,
      queued: Boolean(queueId),
      quote,
      allowed: (fresh, operation, before, walletBefore) => {
        if (automatic && (stopped || generation !== actionGeneration))
          return false;
        const config = settings();
        if (
          automatic &&
          (!config.enabled ||
            !config.autoBuy ||
            !config.items[fresh.type].enabled ||
            config.items[fresh.type].currency !== fresh.currency ||
            battleRecord().used[fresh.type] >= config.items[fresh.type].limit)
        )
          return false;
        if (
          (automatic || hasProfile()) &&
          config.budgetMode !== "item_limits" &&
          fresh.total >
            config.budgets[fresh.currency] - record.spent[fresh.currency]
        )
          return false;
        if (automatic) {
          const currentChoice = chooseBattleAction(
            { ...controller.getSnapshot(), ...before },
            projection(),
            damageBound(),
          );
          if (currentChoice.kind !== "buy" || currentChoice.type !== fresh.type)
            return false;
        }
        if (!beforeReserve(operation, before)) return false;
        reserve(
          {
            kind: "buy",
            quote: fresh,
            ...operation,
            ...(queueId
              ? {
                  queueId,
                  beforeQuantity:
                    before.medicines?.find((item) => item.type === fresh.type)
                      ?.quantity ?? null,
                  walletBefore,
                }
              : {}),
          },
          automatic,
        );
        return true;
      },
    });
    if (result?.confirmed === true) {
      record.spent[quote.currency] += quote.total;
      if (queueId)
        record.queuedReceipts = [...record.queuedReceipts.slice(-127), queueId];
      complete();
      return { kind: "buy" };
    }
    if (result?.rejected) return { kind: "rejected", reason: result.rejected };
    return wait(
      "Покупка не подтверждена или недоступна. Проверьте запас и бюджет; повторной покупки не будет.",
    );
  }
  async function startBattle({
    next = false,
    allowed: canStart = () => true,
  } = {}) {
    if (!allowed() || record.pending) return;
    const actionGeneration = generation;
    const beforeBattleId = controller.getSnapshot().battle?.id ?? null;
    const bossId = controller.getSnapshot().boss?.id ?? null;
    const beforeSend = (operation) => {
      if (
        !allowed() ||
        generation !== actionGeneration ||
        !canStart() ||
        !Number.isSafeInteger(damageBound())
      )
        return false;
      reserve({ kind: "start", bossId, beforeBattleId, ...operation });
      return true;
    };
    if (next)
      await controller.startNextBattle({ allowed: canStart, beforeSend });
    else await controller.start({ beforeSend });
    const result = controller.getSnapshot();
    if (!result.needsRefresh) complete();
    else
      wait(
        `${result.errorStatus === 500 ? "Игровой сервер вернул HTTP 500. " : ""}Проверяем состояние входа в бой. Повторный вход автоматически не отправляется.`,
      );
  }
  async function step({ notBefore = 0 } = {}) {
    const stepGeneration = generation;
    const stillAllowed = () => allowed() && generation === stepGeneration;
    if (!stopped && record.pending) {
      try {
        await recover();
      } catch {
        /* Keep the reservation until a read confirms the result. */
      }
    }
    if (stopped || record.pending)
      return wait(
        notice ||
          "Действия приостановлены: предыдущее действие не подтверждено.",
      );
    if (!available() && priorityActive())
      return wait("Ожидаем приоритетное действие.", 1000);
    if (!available()) {
      try {
        await recover();
      } catch {
        return wait("Ждём восстановления связи с игрой.");
      }
      if (!available()) return wait("Ждём восстановления связи с игрой.");
    }
    if (record.waiting) {
      if (record.waiting.retryAt > now())
        return { kind: "wait", retryAt: record.waiting.retryAt };
      await recover();
      if (controller.getSnapshot().needsRefresh)
        return wait("Ждём восстановления связи с игрой.");
      record.waiting = null;
    }
    if (!stillAllowed()) return { kind: "wait", retryAt: now() + 30000 };
    let state = controller.getSnapshot();
    const choice = chooseBattleAction(state, projection(), damageBound());
    if (choice.kind === "stop") return wait(choice.notice);
    if (choice.kind === "stock") {
      await controller.loadMedicines();
      return controller.getSnapshot().needsRefresh
        ? wait("Ждём обновления запаса аптечек.")
        : { kind: "stock" };
    }
    if (
      Math.max(state.battle.readyAt, notBefore) > now() &&
      choice.kind !== "attack"
    )
      return { kind: "wait" };
    if (choice.kind === "heal") {
      notice = "Лечимся…";
      return use(choice.type, true);
    }
    if (choice.kind === "buy") {
      notice = "Покупаем одну аптечку…";
      return buy(choice.quote, true);
    }
    const ledger = battleRecord();
    let initialInvite = ledger.inviteAttempted === false;
    invitationNotice = invitationDecision(state.battle, {
      initial: initialInvite,
    });
    if (initialInvite && invitationNotice) {
      // A full/unsupported battle must not prevent normal strikes.
      ledger.inviteAttempted = true;
      initialInvite = false;
    }
    const forecast = forecastQuota(state.battle, ledger.samples, now());
    if (!initialInvite && forecast?.atRisk && forecast.remaining > 0)
      invitationNotice =
        "Приглашения отложены — есть риск не успеть набрать норму.";
    if (ledger.inviteAt == null) {
      ledger.inviteAt = now();
      publish();
    }
    // Prefer an already-ready strike. Invitations use an otherwise idle cooldown.
    if (
      (initialInvite && !ledger.inviteBlocked) ||
      Math.max(state.battle.readyAt, notBefore) > now()
    ) {
      if (ledger.inviteBlocked || ledger.inviteAt > now())
        return { kind: "wait" };
      // One bounded fresh read before the mutation; stale quota never authorizes it.
      await controller.refresh();
      state = controller.getSnapshot();
      invitationNotice = invitationDecision(state.battle, {
        initial: initialInvite,
      });
      ledger.inviteAt = now() + 35000 + Math.floor(random() * 10001);
      publish();
      if (
        !stillAllowed() ||
        state.needsRefresh ||
        state.battle?.status !== "active"
      )
        return { kind: "stop" };
      if (
        invitationNotice ||
        (!initialInvite && Math.max(state.battle.readyAt, notBefore) <= now())
      )
        return { kind: "wait" };
      const result = await controller.inviteAll({
        allowed: stillAllowed,
        beforeSend: (operation) => {
          ledger.inviteAttempted = true;
          reserve({ kind: "invite", ...operation });
        },
      });
      if (result?.known) {
        complete();
        ledger.inviteAttempted = true;
        ledger.invitedCount =
          (ledger.invitedCount ?? 0) + (result.invitedCount ?? 0);
        ledger.inviteBlocked = result.forbidden === true;
        ledger.inviteAt =
          now() +
          Math.max(
            35000 + Math.floor(random() * 10001),
            (result.retryAfterSeconds ?? 0) * 1000,
          );
        invitationNotice = result.forbidden
          ? "Приглашать в этот бой нельзя."
          : result.rateLimited
            ? "Приглашения ожидают серверного КД."
            : `Приглашено: ${result.invitedCount ?? 0}`;
        publish();
        return { kind: "invite" };
      }
      if (!record.pending) {
        invitationNotice =
          "Приглашение не отправлено: состояние боя изменилось.";
        publish();
        return { kind: "wait" };
      }
      ledger.inviteBlocked = true;
      return wait(
        "Результат приглашения неизвестен. Проверьте бой; рассылка не повторена.",
      );
    }
    notice = null;
    record.waiting = null;
    publish();
    const attackResult = await controller.attack({
      automatic: true,
      beforeSend: (operation) => {
        if (!stillAllowed() || record.pending) return false;
        reserve({ kind: "attack", ...operation });
        return true;
      },
    });
    const after = controller.getSnapshot();
    if (!after.needsRefresh) complete();
    if (!after.needsRefresh && attackResult?.kind === "equipment") {
      notice = after.notice;
      publish();
      return attackResult;
    }
    if (after.needsRefresh)
      return wait(
        "Результат удара проверяется. Автоматического повтора не будет.",
      );
    if (!after.needsRefresh && after.battle?.id === state.battle.id) {
      // Participant changes invalidate the previous speed window.
      const previous = ledger.samples ?? [];
      ledger.samples = [
        ...(previous.at(-1)?.participantCount === after.battle.participantCount
          ? previous
          : []),
        {
          battleId: after.battle.id,
          at: now(),
          bossHealth: after.battle.bossHealth,
          totalDamage: after.battle.totalDamage,
          participantCount: after.battle.participantCount,
          ownHit: after.battle.lastPlayerDamage ?? null,
          cooldownMs: Math.max(0, after.battle.readyAt - now()),
        },
      ].slice(-12);
      publish();
    }
    return { kind: "attack" };
  }
  return {
    projection,
    configure,
    begin,
    recover,
    startBattle,
    use,
    buy,
    step,
    invalidatePendingWork() {
      generation++;
    },
    cancel() {
      stopped = true;
      generation++;
    },
    acknowledge() {
      const state = controller.getSnapshot();
      if (
        state.pending ||
        state.needsRefresh ||
        state.error ||
        !record.pending ||
        record.pending.queueId ||
        (record.pending.kind !== "start" &&
          !record.battles[record.pending.battleId])
      )
        throw new Error("healing_reconciliation_required");
      // Explicit user acknowledgement counts the reserved maximum conservatively.
      const pending = record.pending;
      if (pending.kind === "heal")
        record.battles[pending.battleId].used[pending.type]++;
      if (pending.kind === "buy")
        record.spent[pending.quote.currency] += pending.quote.total;
      if (pending.kind === "invite")
        record.battles[pending.battleId].inviteBlocked = true;
      notice =
        "Неизвестный расход учтён по резерву. Автобой можно включить вручную.";
      record.waiting = null;
      complete();
    },
    releaseUnsent(operationId) {
      if (
        typeof operationId !== "string" ||
        record.pending?.operationId !== operationId
      )
        return false;
      complete();
      return true;
    },
    queuedState() {
      return {
        pending: record.pending ? { ...record.pending } : null,
        receipts: [...record.queuedReceipts],
      };
    },
    async reconcileQueuedHeal(queueId) {
      if (record.queuedReceipts.includes(queueId)) return true;
      const pending = record.pending;
      if (pending?.queueId !== queueId || pending.kind !== "heal") return false;
      if (controller.getSnapshot().battle?.id !== pending.battleId)
        return false;
      await controller.loadMedicines();
      const current = controller.getSnapshot();
      const quantity = current.medicines?.find(
        (item) => item.type === pending.type,
      )?.quantity;
      if (
        current.needsRefresh ||
        current.error ||
        current.battle?.id !== pending.battleId ||
        !integer(pending.beforeQuantity) ||
        !integer(quantity) ||
        quantity >= pending.beforeQuantity
      )
        return false;
      const ledger = record.battles[pending.battleId];
      if (!ledger) return false;
      ledger.used[pending.type]++;
      record.queuedReceipts = [...record.queuedReceipts.slice(-127), queueId];
      record.waiting = null;
      notice = null;
      complete();
      return true;
    },
    async reconcileQueuedPurchase(queueId, readWallet) {
      const pending = record.pending;
      if (record.queuedReceipts.includes(queueId)) {
        if (controller.getSnapshot().purchaseUncertain) {
          await controller.loadMedicines();
          controller.acknowledgePurchase();
        }
        return !controller.getSnapshot().purchaseUncertain;
      }
      if (pending?.queueId !== queueId || pending.kind !== "buy") return false;
      if (controller.getSnapshot().battle?.id !== pending.battleId)
        return false;
      await controller.loadMedicines();
      const current = controller.getSnapshot();
      const quantity = current.medicines?.find(
        (item) => item.type === pending.quote.type,
      )?.quantity;
      if (
        current.needsRefresh ||
        current.error ||
        current.battle?.id !== pending.battleId ||
        !integer(pending.beforeQuantity) ||
        quantity !== pending.beforeQuantity + pending.quote.quantity ||
        !integer(pending.walletBefore)
      )
        return false;
      const wallet = await readWallet(pending.quote.currency);
      if (wallet !== pending.walletBefore - pending.quote.total) return false;
      record.spent[pending.quote.currency] += pending.quote.total;
      record.queuedReceipts = [...record.queuedReceipts.slice(-127), queueId];
      record.waiting = null;
      notice = null;
      complete();
      controller.acknowledgePurchase();
      return !controller.getSnapshot().purchaseUncertain;
    },
    exportState: () => structuredClone(record),
    nextActionAt(attackAt) {
      const state = controller.getSnapshot(),
        ledger = battleRecord();
      if (
        record.pending ||
        record.waiting ||
        ledger.inviteBlocked ||
        !state.battle
      )
        return attackAt;
      if (ledger.inviteAt == null) {
        ledger.inviteAt =
          ledger.inviteAttempted === false
            ? now()
            : now() + 35000 + Math.floor(random() * 10001);
        publish();
      }
      return Math.min(attackAt, Math.max(now() + 2000, ledger.inviteAt));
    },
  };
}
