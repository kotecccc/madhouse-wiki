import { logFriendError } from "./friend-diagnostics.mjs";
import { recoverBrokenWeapon } from "./weapon-recovery.mjs";
import { inventoryAction } from "./inventory-actions.mjs";
import { weaponEquipment } from "./weapon-equipment.mjs";
import { createBattleAssistant } from "./battle-assistant.mjs";
import { createRaidWaiter } from "./raid-waiter.mjs";
import { createAccountQueue } from "./account-queue.mjs";
import { createWorkActionPermit } from "../bridge/work-action-permit.mjs";
import { createActionQueue, retryDelay } from "./action-queue.mjs";
import {
  createGameOutageFetch,
  emptyGameOutage,
  outageProbe,
} from "./game-outage.mjs";
import {
  AUTOMATION_STATE_SCHEMA_VERSION,
  migrateAutomationState,
} from "./state-migrations.mjs";
import { queuedInventoryAdapter } from "./queued-inventory.mjs";
import { queuedStashCraftAdapter } from "./queued-stash-craft.mjs";
import { queuedFriendRemovalAdapter } from "./queued-friend-removal.mjs";
import { queuedFriendSettingAdapter } from "./queued-friend-setting.mjs";
import { queuedFriendRequestAdapter } from "./queued-friend-request.mjs";
import { queuedFriendResponseAdapter } from "./queued-friend-response.mjs";
import { queuedEnergyBoosterAdapter } from "./queued-energy-booster.mjs";
import { queuedWorkBoosterAdapter } from "./queued-work-booster.mjs";
import { queuedWorkRunAdapter } from "./queued-work-run.mjs";
import { queuedCharacterRunAdapter } from "./queued-character-run.mjs";
import { queuedSubscriptionAdapter } from "./queued-subscription.mjs";
import { queuedBattleStartAdapter } from "./queued-battle-start.mjs";
import { queuedBattleAttackAdapter } from "./queued-battle-attack.mjs";
import { queuedBattleHealAdapter } from "./queued-battle-heal.mjs";
import { queuedBattlePurchaseAdapter } from "./queued-battle-purchase.mjs";
import { queuedInvitationAdapter } from "./queued-invitation.mjs";
import { queuedBusinessRunAdapter } from "./queued-business-run.mjs";
import { queuedFloorRunAdapter } from "./queued-floor-run.mjs";
import { queuedBattleSeriesAdapter } from "./queued-battle-series.mjs";
import { readFriendSnapshot } from "./friend-snapshot.mjs";
import {
  emptyBusinessHelper,
  selectBusiness,
  saveBusiness,
  businessPlan,
  businessProjection,
  refreshBusiness,
  BUSINESS_NOTICES,
} from "./business-assistant.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createRequestPriorityContext } from "./request-priority-context.mjs";
import { createBossBattleController } from "../../src/features/bosses/BossBattle/boss-battle-controller.js";
import {
  resolveBossGoal,
  restoredShopDropGoal,
} from "../../src/features/bosses/BossBattle/boss-goal-options.js";
import { raidDropOutcome } from "./raid-drop-outcome.mjs";
import { createBossBattleGoal } from "../../src/features/bosses/BossBattle/boss-battle-goal.js";
import { isTerminalBossBattle } from "../../src/features/bosses/BossBattle/boss-battle-status.js";
import { createWorkFarm } from "./work-farm.mjs";
import { createFloorRunner } from "./floor-runner.mjs";
import { createFloorActions } from "./floor-actions.mjs";
import { createBusinessCollector } from "./business-collector.mjs";
import { advanceBusinessUpgrade } from "./business-upgrade.mjs";
import { upgradeCharacterPoint } from "./character-stat-upgrade.mjs";
import { createCharacterStatBatch } from "./character-stat-batch.mjs";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";
import { createBattleSeries } from "./battle-series.mjs";
import { createBossBattleRequest } from "../../src/features/bosses/BossBattle/boss-battle-request.js";
import { normalizePvpBattle } from "../../src/features/combat/ActiveBattleDock/active-battle-state.js";
import { normalizeActiveBossBattle } from "../../shared/active-boss-battle.js";
import {
  BOSS_INVITATIONS_PATH,
  projectBossInvitations,
} from "./boss-invitations.mjs";
import { detectedRaids, observeRaids } from "./raid-observations.mjs";
import { createRaidPriority } from "./raid-priority.mjs";
import { tickBuddyStash } from "./buddy-stash.mjs";
import { tickBuddyBooster } from "./buddy-booster.mjs";
import { removeFriend, reconcileFriendRemoval } from "./friend-removal.mjs";
import { createRaidSubscription } from "./raid-subscription.mjs";
import {
  checkRaidFriends,
  inspectRaidFriend,
  reconcileRaidFriend,
  refreshWatchedRaidFriends,
  requestRaidFriend,
  readRaidFriendStatus,
} from "./raid-friends.mjs";

const failure = (status, code) => Object.assign(new Error(code), { status });
const positive = (id) => Number.isSafeInteger(id) && id > 0;
export const characterBattleUncertain = (state, assistant) =>
  Boolean(
    state?.pending ||
    state?.needsRefresh ||
    state?.error ||
    state?.pendingInvitation ||
    state?.purchaseUncertain ||
    assistant?.uncertain,
  );
const INVITATION_DISCOVERY_INTERVAL_MS = 30000;
const safeCommands = new Set([
  "buddy.stop",
  "friends.reconcile",
  "floor.stop",
  "character.refresh",
  "character.stop",
  "raid.friend.check",
  "raid.friend.inspect",
  "raid.friend.refresh",
  "inventory.refresh",
  "raid.stop",
  "raid.pause",
  "raid.resume",
  "invitations.refresh",
  "subscription.stop",
  "business.run.stop",
  "business.run.pause",
  "business.run.resume",
  "work.stop",
  "work.pause",
  "work.resume",
  "work.refresh",
  "auto.stop",
  "auto.pause",
  "auto.resume",
  "goal.stop",
  "pvp.refresh",
  "business.select",
  "business.refresh",
]);
const commands = new Set([
  "energy.booster.use",
  "friends.respond",
  "queue.enqueue",
  "queue.cancel",
  "queue.dismiss",
  "queue.move",
  "buddy.set",
  "buddy.stop",
  "buddy.order",
  "buddy.configure",
  "buddy.resolve",
  "friends.remove",
  "friends.reconcile",
  "friends.favorite",
  "floor.start",
  "floor.stop",
  "character.refresh",
  "character.upgrade",
  "character.start",
  "character.startAll",
  "character.stop",
  "raid.friend.check",
  "raid.friend.inspect",
  "raid.friend.request",
  "raid.friend.refresh",
  "inventory.action",
  "inventory.refresh",
  "equipment.weapon",
  "equipment.refresh",
  "raid.start",
  "raid.stop",
  "raid.pause",
  "raid.resume",
  "invitations.refresh",
  "invitations.accept",
  "subscription.start",
  "subscription.stop",
  "work.refresh",
  "work.plan",
  "work.start",
  "work.booster.use",
  "work.stop",
  "work.pause",
  "work.resume",
  "open",
  "refresh",
  "hydrate",
  "start",
  "next",
  "attack",
  "medicines.open",
  "medicines.close",
  "healing.configure",
  "healing.ack",
  "medicine.use",
  "purchase.prepare",
  "purchase.cancel",
  "purchase.buy",
  "purchase.ack",
  "auto.start",
  "auto.stop",
  "auto.pause",
  "auto.resume",
  "goal.configure",
  "goal.stop",
  "goal.reset",
  "pvp.refresh",
  "favorites.set",
  "business.select",
  "business.save",
  "business.refresh",
  "business.goal",
  "business.run.start",
  "business.run.stop",
  "business.run.pause",
  "business.run.resume",
]);

// One wiki process owns all actors and timers. Browser connections are observers.
export function createAutomationService({
  store,
  getBoss,
  getBusinessCatalogue = () => ({
    businesses: [],
    businessUpgrades: [],
    bosses: [],
  }),
  fetcher = fetch,
  identifyPlayer,
  accountHealth = () => null,
  snapshotFetch = fetcher,
  queueActionGate = null,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
}) {
  const actors = new Map();
  const loading = new Map();
  const identities = new Map();
  const requestPriority = createRequestPriorityContext();
  let closed = false;
  let booting = false;
  let heartbeat = null;
  const savedQueueCooldown = store.getQueueCooldown?.() ?? {
    readyAt: 0,
    failures: 0,
  };
  let actionQueueReadyAt = savedQueueCooldown.readyAt;
  let actionQueueFailures = savedQueueCooldown.failures;
  let currentReservation = null;
  const owner = randomUUID();
  function ensureLease() {
    if (closed || !store.acquireLease(owner, now(), 15000))
      throw failure(503, "automation_worker_unavailable");
  }
  let temporaryOutage = emptyGameOutage();
  const currentGameOutage = () => store.getGameOutage?.() ?? temporaryOutage;
  function queueNotBefore(entry) {
    try {
      const saved = store.getQueueCooldown?.();
      if (saved) {
        actionQueueReadyAt = Math.max(actionQueueReadyAt, saved.readyAt);
        actionQueueFailures = saved.failures;
      }
      return Math.max(actionQueueReadyAt, currentGameOutage().readyAt);
    } catch {
      if (entry) entry.storageFailed = true;
      else for (const actor of actors.values()) actor.storageFailed = true;
      return null;
    }
  }
  fetcher = createGameOutageFetch({
    fetcher: createAccountQueue(fetcher, {
      accountKey: (authorization) =>
        [...actors.values()].find((entry) => entry.credential === authorization)
          ?.playerId ??
        identities.get(createHash("sha256").update(authorization).digest("hex"))
          ?.playerId ??
        authorization,
      now,
      requestPriority: requestPriority.current,
      captureRequestContext: requestPriority.capture,
      ...(queueActionGate
        ? { captureDispatchContext: queueActionGate.capture }
        : {}),
      beforeDispatch: (_url, _init, isQueuedAttempt) => {
        const overallDeadline = queueNotBefore(null);
        const deadline =
          overallDeadline == null
            ? null
            : _init[outageProbe]
              ? actionQueueReadyAt
              : overallDeadline;
        const reservation = isQueuedAttempt();
        if (
          deadline != null &&
          reservation &&
          reservation === currentReservation &&
          deadline <= reservation.until &&
          (_init[outageProbe] || currentGameOutage().readyAt <= now())
        )
          return;
        if (deadline == null || now() < deadline)
          throw Object.assign(new Error("game_outage_wait"), {
            notDispatched: true,
            retryAfterMs: deadline == null ? 0 : deadline - now(),
          });
      },
    }),
    now,
    random,
    load: currentGameOutage,
    save: (state) => {
      ensureLease();
      if (store.setGameOutage) store.setGameOutage(state, owner, now());
      else temporaryOutage = state;
    },
    onStorageError: () => {
      for (const entry of actors.values()) entry.storageFailed = true;
    },
  });
  const gameJson = async (authorization, path) => {
    const response = await fetcher(`https://cargohustle.online${path}`, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(path === "/api/me"
          ? { "X-Madhouse-Snapshot-Refresh": "live" }
          : {}),
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const error = failure(response.status, "game_session_unavailable");
      const header = response.headers?.get?.("Retry-After");
      if (header) {
        const delay = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - now();
        if (Number.isFinite(delay) && delay >= 0) error.retryAfterMs = delay;
      }
      throw error;
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024)
      throw failure(502, "game_response_too_large");
    return JSON.parse(text);
  };
  const readCharacterProfile = async (entry, credential) => {
    const character = entry.characterUpgrade;
    const response = await fetcher("https://cargohustle.online/api/me", {
      headers: {
        Authorization: credential,
        Accept: "application/json",
        "X-Madhouse-Snapshot-Refresh": "live",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (
      !response.ok ||
      response.headers.get("X-Madhouse-Snapshot") === "stale"
    ) {
      const error = failure(
        [401, 403, 429].includes(response.status) ? response.status : 503,
        "character_profile_unavailable",
      );
      const header = response.headers.get("Retry-After");
      if (header) {
        const delay = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - now();
        if (Number.isFinite(delay) && delay >= 0) error.retryAfterMs = delay;
      }
      throw error;
    }
    const raw = await response.json();
    if (
      entry.credential !== credential ||
      String(raw?.playerId) !== entry.playerId ||
      raw?.partial ||
      raw?.error
    )
      throw failure(503, "character_profile_unavailable");
    const keys = ["madness", "aggression", "rage"];
    const fields = [
      "costPerPoint",
      "currency",
      "dailyLimit",
      "dailyUsed",
      "dailyRemaining",
      "nextCost",
      "startCost",
      "maxCost",
    ];
    const projection = {
      characterStats: Object.fromEntries(
        keys.map((key) => [
          key,
          {
            base: raw.characterStats?.[key]?.base,
            total: raw.characterStats?.[key]?.total,
          },
        ]),
      ),
      characterStatsUpgrade: {
        resetAtUtc: raw.characterStatsUpgrade?.resetAtUtc,
        ...Object.fromEntries(
          keys.map((key) => [
            key,
            Object.fromEntries(
              fields.map((field) => [
                field,
                raw.characterStatsUpgrade?.[key]?.[field],
              ]),
            ),
          ]),
        ),
      },
      wallet: {
        gold: raw.wallet?.gold,
        pills: raw.wallet?.pills,
        dollar: raw.wallet?.dollar,
      },
    };
    character.profile = projection;
    return projection;
  };
  function persisted(entry) {
    return {
      schemaVersion: AUTOMATION_STATE_SCHEMA_VERSION,
      version: entry.version,
      credential: entry.credential,
      player: entry.player,
      battle: entry.controller.getSnapshot(),
      goalRecord: entry.goal.exportState(),
      businessHelper: entry.businessHelper,
      characterUpgrade: entry.characterUpgrade,
      workFarm: entry.workFarm.exportState(),
      floorRunner: entry.floorRunner?.getSnapshot() ?? null,
      auto: entry.auto.exportState(),
      pausedAuto: entry.pausedAuto,
      manualBattle: entry.manualBattle,
      pendingAutomation: entry.pendingAutomation,
      assistant: entry.assistant.exportState(),
      pvp: entry.pvp,
      equipment: entry.equipment,
      stashCraft: entry.stashCraft,
      energyBooster: entry.energyBooster,
      buddyHelp: entry.buddyHelp,
      friendRemoval: entry.friendRemoval,
      friendResponse: entry.friendResponse,
      friendSnapshot: entry.friendSnapshot,
      raidFriend: entry.raidFriend,
      raidFriendReceipts: entry.raidFriendReceipts,
      raidFriendStatuses: entry.raidFriendStatuses,
      raidFriendWatch: entry.raidFriendWatch,
      preferences: entry.preferences,
      invitations: entry.invitations,
      raidObservations: observeRaids(entry.raidObservations, [], now()),
      raid: entry.raidWorker.getSnapshot(),
      raidSubscription: entry.raidSubscription?.getSnapshot() ?? null,
      receipts: entry.receipts,
      queuedActions: entry.queuedActions,
      updatedAt: now(),
    };
  }
  function save(entry) {
    if (entry.restoring || closed) return;
    try {
      ensureLease();
      entry.version++;
      store.write(entry.playerId, persisted(entry));
    } catch {
      // No game call is allowed after a durability failure.
      entry.storageFailed = true;
    }
  }
  async function submitCharacterPoint(
    entry,
    expected,
    allowed,
    onConfirmed,
    runId,
  ) {
    const credential = entry.credential;
    const permitted = () =>
      allowed() &&
      !closed &&
      !entry.storageFailed &&
      entry.credential === credential;
    return upgradeCharacterPoint({
      state: entry.characterUpgrade,
      stat: expected.stat,
      expected,
      getProfile: () => readCharacterProfile(entry, credential),
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      allowed: permitted,
      onConfirmed,
      runId,
      post: async (body) => {
        const response = await fetcher(
          "https://cargohustle.online/api/character-stats/upgrade",
          {
            method: "POST",
            headers: {
              Authorization: credential,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(20000),
            canDispatch: () => {
              ensureLease();
              return permitted();
            },
          },
        );
        const result = await response.json();
        if (
          !response.ok &&
          (response.status < 400 ||
            response.status >= 500 ||
            response.status === 429)
        )
          throw failure(response.status, "character_upgrade_failed");
        return {
          ...result,
          _explicitRejection:
            (!response.ok && response.status >= 400 && response.status < 500) ||
            result?.success === false,
        };
      },
    });
  }
  function updateGoal(entry) {
    entry.goal.tick();
    const goal = entry.goal.getSnapshot();
    if (goal && goal.status !== "active" && entry.auto.getSnapshot().enabled)
      entry.auto.stop();
    return goal;
  }
  function characterPriorityActive(entry) {
    return Boolean(
      entry.characterUpgrade?.pending ||
      entry.characterBatch?.running() ||
      entry.stashCraft?.pending ||
      entry.energyBooster?.pending,
    );
  }
  function workPriorityActive(entry) {
    const run = entry.workFarm?.getSnapshot().run;
    if (
      run?.status !== "running" ||
      entry.collector?.running() ||
      entry.floorRunner?.getSnapshot().status === "running" ||
      entry.raidSubscription?.getSnapshot().checkpoint
    )
      return false;
    return !(
      ["waiting", "retrying"].includes(run.phase) &&
      (run.nextActionAt ?? 0) > now() &&
      !run.pending
    );
  }
  function canAct(entry, ignoreInventory = false) {
    if (
      (!ignoreInventory && entry.inventoryBusy) ||
      entry.stashCraft?.pending ||
      characterPriorityActive(entry)
    )
      return false;
    if (entry.workFarm?.getSnapshot().manualPending) return false;
    if (entry.manualBattle?.pending && !entry.queueBattleDispatch) return false;
    if (accountHealth(entry.credential)?.status === "credentials_invalid")
      return false;
    const goal = updateGoal(entry);
    if (
      entry.collector &&
      !entry.raidSubscription?.getSnapshot().checkpoint &&
      !entry.collector.withinTime()
    )
      return false;
    return !(
      goal?.deadlineAt != null &&
      now() >= goal.deadlineAt &&
      !entry.raidWorker?.getSnapshot().stopAfterBattle &&
      goal.status !== "stopped"
    );
  }
  async function refreshAutoDamageLimit(
    entry,
    { alreadyRefreshed = false } = {},
  ) {
    const generation = entry.autoStartGeneration ?? 0;
    if (!alreadyRefreshed) await entry.controller.refresh({ discover: true });
    const refreshed = entry.controller.getSnapshot();
    if (refreshed.needsRefresh || refreshed.error) return false;
    await entry.controller.hydrateDetails();
    const state = entry.controller.getSnapshot();
    return (
      generation === (entry.autoStartGeneration ?? 0) &&
      !state.needsRefresh &&
      !state.error
    );
  }
  function reconcileFinishedBattle(entry) {
    const state = entry.controller.getSnapshot(),
      battle = state.battle;
    if (
      closed ||
      entry.storageFailed ||
      entry.busy ||
      state.pending ||
      state.error ||
      state.errorStatus ||
      state.purchaseUncertain ||
      entry.auto.getSnapshot().enabled ||
      entry.collector.running() ||
      !battle ||
      (isTerminalBossBattle(battle) &&
        !(battle.status === "won" && !battle.rewardKnown))
    )
      return;
    const reason =
      battle.status === "won" && !battle.rewardKnown
        ? "reward"
        : battle.expiresAt != null && battle.expiresAt <= now()
          ? "deadline"
          : battle.playerHealth === 0 || battle.bossHealth === 0
            ? "health"
            : battle.status !== "active"
              ? "status"
              : null;
    if (!reason) return;
    const key = `${battle.id}:${reason}`;
    if (reason === "reward") {
      if (now() < (entry.rewardCheckAt ?? 0)) return;
      entry.rewardCheckAt = now() + 30000;
    } else {
      if (entry.finishedBattleChecks.has(key)) return;
      entry.finishedBattleChecks.add(key);
    }
    if (entry.finishedBattleChecks.size > 64)
      entry.finishedBattleChecks.delete(
        entry.finishedBattleChecks.values().next().value,
      );
    // Reconcile the existing fight only. Delayed rewards get at most one GET
    // every 30 seconds; game mutations are never replayed here.
    void entry.controller.refresh();
  }
  function snapshot(entry) {
    updateGoal(entry);
    reconcileFinishedBattle(entry);
    const state = entry.controller.getSnapshot();
    const queueReadyAt = queueNotBefore(entry);
    return {
      raid: entry.raidWorker.getSnapshot(),
      subscription: (() => {
        const subscription = entry.raidSubscription.getSnapshot();
        if (subscription.mode === "buddy")
          return { enabled: false, phase: "idle", hasSuspendedGoal: false };
        const { checkpoint, ...publicState } = subscription;
        return {
          ...publicState,
          hasSuspendedGoal: Boolean(checkpoint),
          suspendedAuto: Boolean(
            (checkpoint?.auto?.enabled ||
              checkpoint?.autoPaused ||
              (checkpoint && entry.pausedAuto)) &&
            !checkpoint.raidEnabled &&
            !checkpoint.raidPaused &&
            !entry.raidWorker.getSnapshot().userPaused &&
            !checkpoint.businessRunning &&
            !checkpoint.businessPaused &&
            entry.businessHelper.run?.status !== "paused" &&
            !checkpoint.floorOwned,
          ),
          suspendedStandaloneGoal: Boolean(
            checkpoint?.goal &&
            !checkpoint.goal.stopped &&
            !checkpoint.auto?.enabled &&
            !checkpoint.autoPaused &&
            !entry.pausedAuto &&
            !checkpoint.raidEnabled &&
            !checkpoint.raidPaused &&
            !entry.raidWorker.getSnapshot().userPaused &&
            !checkpoint.businessRunning &&
            !checkpoint.businessPaused &&
            entry.businessHelper.run?.status !== "paused" &&
            !checkpoint.floorOwned,
          ),
        };
      })(),
      buddy: (() => {
        const value = entry.raidSubscription.getSnapshot();
        if (value.mode !== "buddy")
          return { enabled: false, phase: "idle", friendIds: [] };
        return {
          mode: "buddy",
          enabled: value.enabled,
          phase: value.phase,
          friendIds: value.friendIds ?? [],
          activeFriendId: value.activeFriendId ?? null,
          hasSuspendedGoal: Boolean(value.checkpoint),
          suspendedAuto: Boolean(
            (value.checkpoint?.auto?.enabled ||
              value.checkpoint?.autoPaused ||
              (value.checkpoint && entry.pausedAuto)) &&
            !value.checkpoint.raidEnabled &&
            !value.checkpoint.raidPaused &&
            !entry.raidWorker.getSnapshot().userPaused &&
            !value.checkpoint.businessRunning &&
            !value.checkpoint.businessPaused &&
            entry.businessHelper.run?.status !== "paused" &&
            !value.checkpoint.floorOwned,
          ),
          suspendedStandaloneGoal: Boolean(
            value.checkpoint?.goal &&
            !value.checkpoint.goal.stopped &&
            !value.checkpoint.auto?.enabled &&
            !value.checkpoint.autoPaused &&
            !entry.pausedAuto &&
            !value.checkpoint.raidEnabled &&
            !value.checkpoint.raidPaused &&
            !entry.raidWorker.getSnapshot().userPaused &&
            !value.checkpoint.businessRunning &&
            !value.checkpoint.businessPaused &&
            entry.businessHelper.run?.status !== "paused" &&
            !value.checkpoint.floorOwned,
          ),
          log: value.log ?? [],
        };
      })(),
      detectedRaids: detectedRaids(
        entry.raidObservations,
        entry.invitations.items,
        now(),
      ),
      queuedActions: entry.actionQueue.snapshot(),
      queueNotBefore: queueReadyAt,
      gameHealth: accountHealth(entry.credential),
      version: entry.version,
      serverTime: now(),
      invitations: {
        ...entry.invitations,
        items: entry.invitations.items.map((item) => ({
          ...item,
          available: item.available && item.expiresAt > now(),
        })),
      },
      battle: {
        ...state,
        healing: entry.assistant.projection(),
        visible: false,
        ...(entry.storageFailed
          ? {
              needsRefresh: true,
              error: "Серверное хранилище недоступно. Действия остановлены.",
            }
          : {}),
      },
      goal: entry.goal.getSnapshot(),
      auto: {
        ...entry.auto.getSnapshot(),
        enabled: entry.auto.getSnapshot().enabled || entry.collector.running(),
        userPaused: Boolean(entry.pausedAuto),
        resumeRequested: Boolean(entry.pausedAuto?.resumeRequested),
        queueId:
          entry.pausedAuto?.checkpoint?.queueId ??
          (entry.raidSubscription.getSnapshot().checkpoint?.auto?.enabled
            ? entry.raidSubscription.getSnapshot().checkpoint.auto.queueId
            : null) ??
          entry.auto.getSnapshot().queueId ??
          null,
      },
      pvp: entry.pvp,
      equipment: entry.equipment,
      buddyHelp: {
        boostersEnabled: entry.buddyHelp.boostersEnabled,
        fullBoosterReserve: entry.buddyHelp.fullBoosterReserve,
        stashEnabled: entry.buddyHelp.stashEnabled,
        stashReserve: entry.buddyHelp.stashReserve,
        hasPending: Boolean(
          entry.buddyHelp.pending || entry.buddyHelp.stashPending,
        ),
        pendingBooster: entry.buddyHelp.pending
          ? { playerId: entry.buddyHelp.pending.playerId }
          : null,
        pendingStash: entry.buddyHelp.stashPending
          ? {
              playerId: entry.buddyHelp.stashPending.playerId,
              setId: entry.buddyHelp.stashPending.setId,
              ingredientId: entry.buddyHelp.stashPending.ingredientId,
            }
          : null,
        notice: entry.buddyHelp.notice,
        log: entry.buddyHelp.log ?? [],
      },
      friendRemoval: entry.friendRemoval,
      friendResponse: entry.friendResponse,
      raidFriend: {
        playerId:
          entry.raidFriend.pending?.playerId ??
          entry.raidFriend.playerId ??
          null,
        status: entry.raidFriend.status ?? null,
        username: entry.raidFriend.username ?? null,
        statuses: {
          ...entry.raidFriendStatuses,
          ...(entry.raidFriend.pending
            ? {
                [`id:${entry.raidFriend.pending.playerId}`]: "uncertain",
                ...(entry.raidFriend.username
                  ? { [`name:${entry.raidFriend.username}`]: "uncertain" }
                  : {}),
              }
            : {}),
        },
      },
      preferences: entry.preferences,
      characterUpgrade: entry.characterUpgrade,
      workFarm: entry.workFarm.getSnapshot(),
      floorRunner: entry.floorRunner.getSnapshot(),
      businessAssistant: businessProjection(
        entry.businessHelper,
        Object.keys(entry.businessHelper.configs).length
          ? getBusinessCatalogue()
          : { businesses: [], businessUpgrades: [], bosses: [] },
      ),
    };
  }
  function createActor(playerId, saved = null) {
    const migration = migrateAutomationState(saved);
    saved = migration.value;
    const entry = {
      playerId,
      businessHelper: saved?.businessHelper ?? emptyBusinessHelper(),
      characterUpgrade: saved?.characterUpgrade ?? {
        pending: null,
        profile: null,
        notice: null,
      },
      credential: saved?.credential ?? null,
      player: saved?.player ?? null,
      equipment: saved?.equipment ?? { pending: null, checked: false },
      stashCraft: saved?.stashCraft ?? { pending: null, receipts: [] },
      energyBooster: saved?.energyBooster ?? { pending: null, receipts: [] },
      buddyHelp: {
        boostersEnabled: false,
        fullBoosterReserve: 1,
        stashEnabled: false,
        stashReserve: 1,
        pending: null,
        stashPending: null,
        notice: null,
        log: [],
        ...saved?.buddyHelp,
      },
      buddyHelpNextAt: 0,
      friendRemoval: saved?.friendRemoval ?? { pending: null },
      friendResponse: saved?.friendResponse ?? { pending: null },
      friendResponseNextCheck: 0,
      friendSnapshot: saved?.friendSnapshot ?? {
        items: null,
        updatedAt: null,
        failures: 0,
        nextAt: 0,
        enabled: false,
      },
      friendSnapshotRefreshing: false,
      friendRemovalRefreshing: false,
      raidFriend: saved?.raidFriend ?? { pending: null, status: null },
      raidFriendReceipts: saved?.raidFriendReceipts ?? [],
      raidFriendStatuses: saved?.raidFriendStatuses ?? {},
      raidFriendWatch: saved?.raidFriendWatch ?? {},
      raidFriendRefreshAt: 0,
      raidFriendRefreshing: false,
      preferences: saved?.preferences ?? { favoriteBossIds: [] },
      invitations: saved?.invitations ?? {
        items: [],
        loaded: false,
        refreshedAt: null,
        notice: null,
      },
      raidObservations: observeRaids(saved?.raidObservations, [], now()),
      receipts: saved?.receipts ?? [],
      queuedActions: saved?.queuedActions ?? [],
      queueActiveBooster: false,
      pausedAuto: saved?.pausedAuto ?? null,
      manualBattle: saved?.manualBattle ?? { pending: null, receipts: [] },
      pendingAutomation: saved?.pendingAutomation ?? null,
      queueBattleDispatch: null,
      version: saved?.version ?? 0,
      pvp: saved?.pvp
        ? {
            ...saved.pvp,
            pending: false,
            error: Boolean(saved.pvp.pending || saved.pvp.error),
          }
        : { battle: null, pending: false, error: false },
      restoring: true,
      needsInitialReconcile: Boolean(
        saved?.battle?.boss &&
        !saved.battle.pending &&
        !saved.battle.needsRefresh,
      ),
      needsPvpDiscovery: !saved?.pvp?.battle,
      storageFailed: false,
      finishedBattleChecks: new Set(),
      busy: false,
      invitationDiscoveryAt: 0,
      invitationDiscoveryPromise: null,
    };
    const request = createBossBattleRequest({
      authorize: ({ url }) => ({
        url: `https://cargohustle.online${url}`,
        headers: { Authorization: entry.credential },
      }),
      fetcher: async (url, init) => {
        if (closed || entry.storageFailed || !entry.credential)
          throw failure(503, "automation_stopped");
        // The controller has already published pending; this sync commit precedes POST.
        if (init.method === "POST") {
          save(entry);
          if (entry.storageFailed)
            throw failure(503, "automation_storage_unavailable");
        }
        const dispatchGeneration = entry.autoStartGeneration ?? 0;
        const credential = entry.credential;
        const response = await fetcher(url, {
          ...init,
          redirect: "error",
          canDispatch: () => {
            if (
              closed ||
              entry.storageFailed ||
              entry.credential !== credential
            )
              return false;
            if (init.method !== "POST") return true;
            ensureLease();
            const operationId = JSON.parse(init.body || "null")?.operationId;
            const queued = entry.queueBattleDispatch;
            return (
              dispatchGeneration === (entry.autoStartGeneration ?? 0) &&
              (queued && queued.operationId === operationId
                ? queued.canDispatch() && canAct(entry, true)
                : canAct(entry))
            );
          },
        }).catch((error) => {
          if (error.notDispatched && init.method === "POST")
            entry.assistant?.releaseUnsent(
              JSON.parse(init.body || "null")?.operationId,
            );
          if (
            error.notDispatched &&
            entry.manualBattle.pending?.operationId ===
              JSON.parse(init.body || "null")?.operationId
          ) {
            if (entry.manualBattle.pending.kind === "invitation")
              entry.controller.releaseUnsentInvitation(
                entry.manualBattle.pending.invitationId,
              );
            entry.manualBattle.pending = null;
            save(entry);
          }
          throw error;
        });
        const automated = () =>
          !closed &&
          !entry.storageFailed &&
          dispatchGeneration === (entry.autoStartGeneration ?? 0) &&
          canAct(entry, true) &&
          (entry.auto?.getSnapshot().enabled ||
            entry.raidWorker?.getSnapshot().enabled ||
            entry.collector?.running());
        if (
          init.method === "POST" &&
          /\/api\/bosses\/battles\/[A-Za-z0-9_-]+\/attack$/.test(
            new URL(url).pathname,
          ) &&
          [400, 409, 422].includes(response.status) &&
          automated()
        ) {
          let errorBody;
          try {
            errorBody = await response.clone().json();
          } catch {
            /* Unknown failures remain unconfirmed. */
          }
          if (
            typeof errorBody?.error === "string" &&
            errorBody.error !== "battle_finished" &&
            !entry.equipment?.pending &&
            !entry.inventoryBusy
          ) {
            entry.inventoryBusy = true;
            try {
              const maintenance = await recoverBrokenWeapon({
                entry,
                fetcher,
                save,
                allowed: automated,
              });
              if (maintenance)
                return Response.json({ weaponMaintenance: maintenance });
            } finally {
              entry.inventoryBusy = false;
            }
          }
        }
        return response;
      },
    });
    entry.controller = createBossBattleController({
      request,
      now,
      canManualAttack: () =>
        !entry.auto.getSnapshot().enabled && !entry.collector?.running(),
      canStartBattle: () =>
        entry.goal.canStart() && (entry.collector?.canStartBattle() ?? true),
      canSendMutation: () =>
        (entry.queueBattleDispatch
          ? entry.queueBattleDispatch.canDispatch() && canAct(entry, true)
          : canAct(entry)) && !entry.equipment?.pending,
      getPlayerIdentity: () => entry.player,
    });
    if (saved?.battle) entry.controller.restoreState(saved.battle);
    entry.goal = createBossBattleGoal({ controller: entry.controller, now });
    const restoredGoal = restoredShopDropGoal(saved?.goalRecord);
    if (restoredGoal) entry.goal.restoreState(restoredGoal);
    if (saved?.raid?.stopAfterBattle || saved?.auto?.stopAfterBattle)
      entry.goal.finishCurrentBattle();
    const refreshAvailability = async () => {
      if (
        ["unavailable", "credentials_invalid"].includes(
          accountHealth(entry.credential)?.status,
        )
      )
        await gameJson(entry.credential, "/api/me");
    };
    entry.assistant = createBattleAssistant({
      controller: entry.controller,
      saved: saved?.assistant,
      now,
      random,
      available: () =>
        !closed &&
        !entry.storageFailed &&
        canAct(entry, Boolean(entry.queueBattleDispatch)),
      priorityActive: () =>
        characterPriorityActive(entry) || entry.inventoryBusy,
      readAvailable: () =>
        !closed && !entry.storageFailed && Boolean(entry.credential),
      refreshAvailability,
      onChange: () => save(entry),
    });
    const startAssistant = () =>
      entry.assistant.begin(
        `${entry.controller.getSnapshot().boss?.id}:${entry.goal.getSnapshot()?.startedAt ?? "single"}`,
      );
    entry.auto = createBattleSeries({
      savedStartReceipts: [
        ...(Array.isArray(saved?.auto?.startReceipts)
          ? saved.auto.startReceipts
          : []),
        ...(saved?.auto?.queueId ? [saved.auto.queueId] : []),
      ].slice(-128),
      controller: {
        ...entry.controller,
        attack: (options) => entry.assistant.step(options),
        start: ({ allowed } = {}) => entry.assistant.startBattle({ allowed }),
        nextActionAt: (at) => entry.assistant.nextActionAt(at),
        startNextBattle: ({ allowed = () => true } = {}) =>
          entry.assistant.startBattle({
            next: true,
            allowed: () =>
              allowed() &&
              Number.isSafeInteger(
                entry.controller.getSnapshot().damageLimit?.value,
              ),
          }),
        beginAutomation: startAssistant,
        recoverAutomation: () => entry.assistant.recover(),
        stopAutomation: () => entry.assistant.cancel(),
      },
      goal: entry.goal,
      now,
      schedule,
      cancel,
      random,
      priorityActive: () => workPriorityActive(entry),
    });
    entry.collector = createBusinessCollector({
      helper: entry.businessHelper,
      controller: entry.controller,
      goal: entry.goal,
      auto: entry.auto,
      getCatalogue: getBusinessCatalogue,
      getBoss,
      priorityActive: () =>
        characterPriorityActive(entry) || entry.inventoryBusy,
      canResume: () =>
        !entry.raidWorker.getSnapshot().enabled &&
        !entry.raidWorker.getSnapshot().userPaused &&
        !entry.auto.getSnapshot().enabled &&
        !entry.pausedAuto &&
        entry.floorRunner.getSnapshot().status !== "running" &&
        !entry.raidSubscription.getSnapshot().checkpoint &&
        !entry.inventoryBusy,
      get: (path) => gameJson(entry.credential, path),
      upgrade: (run, valid) => {
        const business = getBusinessCatalogue().businesses.find(
          (item) => item.id === run.businessId,
        );
        const credential = entry.credential;
        const allowed = () =>
          valid() &&
          !run.stopRequested &&
          !closed &&
          !entry.storageFailed &&
          Boolean(credential) &&
          entry.credential === credential &&
          !entry.equipment?.pending &&
          !entry.workFarm?.getSnapshot().manualPending &&
          !entry.raidSubscription?.getSnapshot().checkpoint &&
          !entry.controller.getSnapshot().pending &&
          entry.controller.getSnapshot().battle?.status !== "active" &&
          canAct(entry);
        return advanceBusinessUpgrade({
          run,
          businessId: Number(business?.apiId),
          get: (path) => gameJson(credential, path),
          allowed,
          persist: () => {
            save(entry);
            return !entry.storageFailed;
          },
          post: (path, body) =>
            fetcher(`https://cargohustle.online${path}`, {
              method: "POST",
              headers: {
                Authorization: credential,
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
              redirect: "error",
              signal: AbortSignal.timeout(20000),
              canDispatch: () => {
                ensureLease();
                return allowed();
              },
            }),
        });
      },
      now,
      schedule,
      cancel,
      onChange: () => save(entry),
    });
    entry.workFarm = createWorkFarm({
      saved: saved?.workFarm,
      available: (mode) =>
        !closed &&
        !entry.storageFailed &&
        Boolean(entry.credential) &&
        !entry.raidPolling &&
        !entry.inventoryBusy &&
        !entry.stashCraft?.pending &&
        !entry.energyBooster?.pending &&
        !entry.equipment?.pending &&
        !entry.characterUpgrade.pending &&
        (!entry.characterBatch?.running() ||
          Boolean(entry.workFarm?.getSnapshot().run?.pending)) &&
        !entry.businessHelper.run?.pendingUpgrade &&
        !entry.controller.getSnapshot().pending &&
        (mode === "energy" ||
          ((!entry.auto.getSnapshot().enabled ||
            (["between_battles", "yielding"].includes(
              entry.auto.getSnapshot().phase,
            ) &&
              workPriorityActive(entry))) &&
            !entry.collector.running() &&
            entry.controller.getSnapshot().battle?.status !== "active")),
      manualReconcileManaged: () =>
        accountHealth(entry.credential)?.status === "credentials_invalid" ||
        Boolean(
          entry.actionQueue
            ?.snapshot()
            .some(
              (job) =>
                job.type === "work.booster" &&
                ["queued", "waiting", "running", "reconciling"].includes(
                  job.status,
                ),
            ),
        ),
      getStash: async () => {
        const response = await snapshotFetch(
          "https://cargohustle.online/api/stash/sets",
          { headers: { Authorization: entry.credential } },
        );
        if (!response.ok) throw new Error("stash_unavailable");
        return response.json();
      },
      getWork: (id) =>
        (getBusinessCatalogue().works || []).find(
          (work) => Number(work.workId ?? work.numericId ?? work.apiId) === id,
        ),
      request: async (method, path, body, { signal, canDispatch } = {}) => {
        if (
          closed ||
          entry.restoring ||
          entry.storageFailed ||
          !entry.credential
        )
          throw failure(503, "automation_stopped");
        save(entry);
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        const fetchOptions = {
          method,
          headers: {
            Authorization: entry.credential,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: "error",
          cache: "no-store",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
            : AbortSignal.timeout(20000),
          ...(canDispatch ? { canDispatch } : {}),
        };
        const send = () =>
          fetcher(`https://cargohustle.online${path}`, fetchOptions);
        let response;
        if (
          queueActionGate &&
          method === "POST" &&
          path === "/api/works/tasks/perform"
        ) {
          const credential = entry.credential;
          const pending = entry.workFarm.getSnapshot().run?.pending;
          if (
            !pending ||
            pending.kind !== "performing" ||
            pending.operationId !== body?.operationId ||
            pending.taskId !== body?.taskId
          )
            throw failure(409, "work_checkpoint_missing");
          const permit = createWorkActionPermit({
            authorization: credential,
            workId: body.workId,
            taskId: body.taskId,
            operationId: body.operationId,
            checkpointIsCurrent: () => {
              const run = entry.workFarm.getSnapshot().run;
              return (
                !closed &&
                !entry.storageFailed &&
                !entry.restoring &&
                !fetchOptions.signal.aborted &&
                entry.credential === credential &&
                run?.status === "running" &&
                run.workId === body.workId &&
                run.pending?.kind === "performing" &&
                run.pending.operationId === body.operationId &&
                run.pending.taskId === body.taskId
              );
            },
          });
          response = await queueActionGate.runWork(permit, send);
        } else response = await send();
        if (!response.ok) {
          const error = failure(
            response.status,
            `Сервис работёнок временно недоступен (HTTP ${response.status}). Запрос не повторён.`,
          );
          const header = response.headers.get("Retry-After");
          if (header) {
            const delay = /^\d+$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - now();
            if (Number.isFinite(delay) && delay >= 0)
              error.retryAfterMs = delay;
          }
          throw error;
        }
        const text = await response.text();
        if (Buffer.byteLength(text) > 4 * 1024 * 1024)
          throw failure(502, "Слишком большой ответ игры.");
        return JSON.parse(text);
      },
      now,
      schedule,
      cancel,
      random,
      onChange: () => save(entry),
    });
    entry.raidWorker = createRaidWaiter({
      saved: saved?.raid,
      now,
      state: entry.controller.getSnapshot,
      goal: entry.goal,
      auto: entry.auto,
      priorityActive: () =>
        characterPriorityActive(entry) || entry.inventoryBusy,
      workPriority: () => workPriorityActive(entry),
      canResume: () =>
        !entry.collector.running() &&
        !entry.auto.getSnapshot().enabled &&
        !entry.pausedAuto &&
        entry.floorRunner.getSnapshot().status !== "running" &&
        !entry.raidSubscription.getSnapshot().checkpoint,
      available: () =>
        !closed &&
        !entry.storageFailed &&
        Boolean(entry.credential) &&
        canAct(entry),
      lock: () => {
        if (
          entry.busy ||
          (workPriorityActive(entry) && !entry.workFarm.canSuspend()) ||
          (characterPriorityActive(entry) &&
            !characterBattleUncertain(
              entry.controller.getSnapshot(),
              entry.assistant.projection(),
            ))
        )
          return false;
        entry.busy = true;
        entry.raidPolling = true;
        return true;
      },
      unlock: () => {
        entry.raidPolling = false;
        entry.busy = false;
      },
      refresh: async ({ force = false } = {}) => {
        await refreshAvailability();
        const state = entry.controller.getSnapshot();
        if (
          state.boss &&
          !state.pendingInvitation &&
          (state.error || state.needsRefresh)
        )
          await entry.controller.refresh({ discover: true });
        await refreshInvitations(entry, force);
      },
      invitations: () => entry.invitations.items,
      accept: (id, allowed) => acceptInvitation(entry, id, allowed),
      startSolo: async (allowed) => {
        if (!allowed() || workPriorityActive(entry) || !entry.goal.canStart())
          return;
        if (!entry.controller.allowSoloContinuation()) return;
        startAssistant();
        await entry.assistant.startBattle({
          next: Boolean(entry.controller.getSnapshot().battle),
          allowed: () => allowed() && !workPriorityActive(entry),
        });
      },
      onChange: () => save(entry),
    });
    const priority = createRaidPriority({
      controller: entry.controller,
      goal: entry.goal,
      auto: entry.auto,
      raid: entry.raidWorker,
      work: entry.workFarm,
      business: entry.collector,
    });
    entry.raidSubscription = createRaidSubscription({
      saved: saved?.raidSubscription,
      now,
      priorityActive: () =>
        characterPriorityActive(entry) || entry.inventoryBusy,
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      lock: () => {
        if (
          entry.busy ||
          entry.inventoryBusy ||
          entry.storageFailed ||
          entry.stashCraft?.pending ||
          entry.characterUpgrade.pending ||
          (entry.characterBatch?.running() &&
            !["joining", "confirming"].includes(
              entry.raidSubscription.getSnapshot().phase,
            ) &&
            !(
              entry.raidSubscription.getSnapshot().phase === "fighting" &&
              characterBattleUncertain(
                entry.controller.getSnapshot(),
                entry.assistant.projection(),
              )
            )) ||
          !entry.credential
        )
          return false;
        entry.busy = true;
        return true;
      },
      unlock: () => {
        entry.busy = false;
      },
      capture: () => {
        if (
          entry.equipment?.pending ||
          entry.workFarm.getSnapshot().manualPending
        )
          return null;
        const checkpoint = priority.capture();
        return checkpoint
          ? {
              ...checkpoint,
              businessPaused: entry.businessHelper.run?.status === "paused",
              raidPaused: Boolean(entry.raidWorker.getSnapshot().userPaused),
              autoPaused: Boolean(entry.pausedAuto),
              floorOwned: entry.floorRunner?.getSnapshot().status === "running",
              floorTarget: entry.floorRunner?.getSnapshot().target ?? null,
            }
          : null;
      },
      suspend: async (checkpoint) => {
        const state = entry.controller.getSnapshot();
        if (
          state.boss &&
          !state.pending &&
          !state.pendingInvitation &&
          (state.needsRefresh || state.error)
        )
          await entry.controller.refresh({ discover: true });
        return priority.suspend(checkpoint);
      },
      join: (invitation, allowed) =>
        acceptInvitation(entry, invitation.invitationId, allowed, {
          leaderPlayerId: invitation.leaderPlayerId,
          inviterPlayerId: invitation.inviterPlayerId,
          bossId: invitation.bossId,
          battleId: invitation.battleId,
        }),
      reconcile: async (subscription) => {
        if (entry.controller.getSnapshot().pendingInvitation)
          await refreshInvitations(entry, true);
        let state = entry.controller.getSnapshot();
        if (
          !state.pendingInvitation &&
          state.boss &&
          (state.needsRefresh || state.error)
        ) {
          await entry.controller.refresh({ discover: true });
          state = entry.controller.getSnapshot();
        }
        if (
          state.pendingInvitation ||
          state.pending ||
          state.needsRefresh ||
          state.error ||
          state.purchaseUncertain
        )
          return "unknown";
        if (state.invitationOnly && state.battle?.id === subscription.battleId)
          return "joined";
        const me = await gameJson(entry.credential, "/api/me");
        if (Object.hasOwn(me, "activeBossBattle"))
          return me.activeBossBattle === null ? "absent" : "unknown";
        const detail = await gameJson(
          entry.credential,
          `/api/bosses/${subscription.bossId}`,
        );
        return Number(detail?.id) === subscription.bossId &&
          detail.activeBattle === null
          ? "absent"
          : "unknown";
      },
      battle: async (subscription) => {
        let state = entry.controller.getSnapshot();
        if (state.pendingInvitation) await refreshInvitations(entry, true);
        state = entry.controller.getSnapshot();
        if (
          !state.pendingInvitation &&
          state.boss &&
          (state.needsRefresh || state.error)
        ) {
          await entry.controller.refresh({ discover: true });
          state = entry.controller.getSnapshot();
        }
        if (
          state.pending ||
          state.pendingInvitation ||
          state.needsRefresh ||
          state.error ||
          state.purchaseUncertain
        )
          return "uncertain";
        if (state.battle?.status === "active")
          return state.battle.id === subscription.battleId
            ? "active"
            : "uncertain";
        const outcome = raidDropOutcome(subscription, state.battle);
        if (outcome === "reward_unknown") {
          await entry.controller.refresh();
          return "uncertain";
        }
        return outcome;
      },
      fight: async () => {
        if (!entry.auto.getSnapshot().enabled)
          entry.auto.start({ singleBattle: true });
      },
      restore: async (checkpoint) => {
        if (
          entry.controller.getSnapshot().invitationOnly &&
          !entry.controller.allowSoloContinuation()
        )
          return false;
        if (checkpoint.bossId) {
          const boss = await getBoss(checkpoint.bossId);
          if (!boss) return false;
          if (
            entry.raidSubscription.getSnapshot().checkpoint?.bossId !==
            checkpoint.bossId
          )
            return false;
          await entry.controller.open(boss);
          const state = entry.controller.getSnapshot();
          if (
            state.boss?.id !== checkpoint.bossId ||
            state.needsRefresh ||
            state.error ||
            state.pending ||
            state.battle?.status === "active"
          )
            return false;
        }
        const currentCheckpoint =
          entry.raidSubscription.getSnapshot().checkpoint;
        if (
          !currentCheckpoint ||
          currentCheckpoint.bossId !== checkpoint.bossId
        )
          return false;
        checkpoint = currentCheckpoint;
        if (checkpoint.goal) entry.goal.restoreState(checkpoint.goal);
        else entry.goal.reset();
        if (checkpoint.raidEnabled) entry.raidWorker.resume();
        if (checkpoint.businessRunning) entry.collector.resume(checkpoint.auto);
        else if (
          checkpoint.auto?.enabled &&
          !checkpoint.raidEnabled &&
          !entry.auto.getSnapshot().enabled &&
          entry.goal.getSnapshot()?.status === "active"
        )
          entry.auto.start({ checkpoint: checkpoint.auto });
        if (checkpoint.workRunning) entry.workFarm.resume();
        return !entry.storageFailed;
      },
    });
    entry.floorActions = createFloorActions({
      entry,
      get: (path) => gameJson(entry.credential, path),
      getCatalogue: getBusinessCatalogue,
      getBoss,
      refreshAutoDamageLimit: () => refreshAutoDamageLimit(entry),
      configureAutoGoal,
      now,
    });
    entry.floorRunner = createFloorRunner({
      saved: saved?.floorRunner,
      ...entry.floorActions,
      priorityActive: () =>
        characterPriorityActive(entry) || entry.inventoryBusy,
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      now,
    });
    entry.characterBatch = createCharacterStatBatch({
      state: entry.characterUpgrade,
      read: () => readCharacterProfile(entry, entry.credential),
      step: (quote, allowed, confirmed, runId) =>
        submitCharacterPoint(entry, quote, allowed, confirmed, runId),
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      lock: () => {
        if (
          entry.busy ||
          entry.inventoryBusy ||
          entry.storageFailed ||
          entry.stashCraft?.pending ||
          !entry.credential ||
          !entry.collector.idleForPriority() ||
          !entry.workFarm.canSuspend() ||
          entry.workFarm.getSnapshot().manualPending ||
          entry.equipment?.pending ||
          ["joining", "confirming"].includes(
            entry.raidSubscription.getSnapshot().phase,
          ) ||
          characterBattleUncertain(
            entry.controller.getSnapshot(),
            entry.assistant.projection(),
          )
        )
          return false;
        entry.busy = true;
        return true;
      },
      unlock: () => {
        entry.busy = false;
      },
      schedule,
      cancel,
      now,
      random,
    });
    const startedQueueActor = (job) =>
      job.status === "reconciling" &&
      ((job.type === "floor.start" && entry.floorRunner.hasStarted(job.id)) ||
        (job.type === "work.start" &&
          (entry.workFarm.getSnapshot().startReceipts ?? []).includes(
            job.id,
          )) ||
        (job.type === "character.start" &&
          (entry.characterUpgrade.startReceipts ?? []).includes(job.id)) ||
        (job.type === "subscription.start" &&
          (entry.raidSubscription.getSnapshot().startReceipts ?? []).includes(
            job.id,
          )) ||
        (job.type === "business.start" &&
          (entry.businessHelper.run?.queueId === job.id ||
            (entry.businessHelper.startReceipts ?? []).includes(job.id))) ||
        (["auto.start", "raid.start"].includes(job.type) &&
          (() => {
            const state = (
              job.type === "auto.start" ? entry.auto : entry.raidWorker
            ).getSnapshot();
            return (
              state.queueId === job.id ||
              (state.startReceipts ?? []).includes(job.id)
            );
          })()));
    const floorBlocksQueue = (job) => {
      const floor = entry.floorRunner.getSnapshot();
      if (floor.phase === "launching") return true;
      if (floor.status !== "running") return false;
      return ![
        "inventory",
        "stash.craft",
        "friend.remove",
        "friend.request",
        "friend.response",
        "friend.favorite",
        "friend.buddy",
        "subscription.start",
        "character.start",
      ].includes(job.type);
    };
    const queueBlockedBy = (job) => {
      if (closed || entry.storageFailed) return "storage";
      if (
        !entry.credential ||
        accountHealth(entry.credential)?.status === "credentials_invalid"
      )
        return "credentials";
      try {
        if (now() < currentGameOutage().readyAt) return "game";
      } catch {
        entry.storageFailed = true;
        return "storage";
      }
      if (startedQueueActor(job)) return null;
      if (
        entry.energyBooster.pending &&
        entry.energyBooster.pending.id !== job.id
      )
        return "action";
      if (entry.stashCraft.pending && entry.stashCraft.pending.id !== job.id)
        return "action";
      if (
        entry.friendResponse.pending &&
        entry.friendResponse.pending.id !== job.id
      )
        return "action";
      if (entry.busy || entry.inventoryBusy) return "action";
      if (
        !entry.collector.idleForPriority() ||
        (entry.assistant.projection().uncertain &&
          entry.assistant.queuedState().pending?.queueId !== job.id) ||
        (entry.manualBattle.pending &&
          entry.manualBattle.pending.id !== job.id) ||
        (entry.pendingAutomation && entry.pendingAutomation.id !== job.id) ||
        entry.businessHelper.run?.pendingUpgrade ||
        !(
          entry.workFarm.canSuspend() ||
          (job.type === "work.booster" && entry.workFarm.canReconcileManual())
        ) ||
        entry.characterBatch.running() ||
        floorBlocksQueue(job) ||
        entry.raidSubscription.getSnapshot().checkpoint ||
        entry.controller.getSnapshot().pending
      )
        return "action";
      if (now() < actionQueueReadyAt)
        return actionQueueFailures ? "game" : "rate";
      return null;
    };
    entry.priorityActionBlockedBy = queueBlockedBy;
    entry.actionQueue = createActionQueue({
      saved: entry.queuedActions,
      adapters: {
        inventory: queuedInventoryAdapter({ entry, fetcher, save }),
        "stash.craft": queuedStashCraftAdapter({ entry, fetcher, save }),
        "friend.remove": queuedFriendRemovalAdapter({ entry, fetcher, save }),
        "friend.favorite": queuedFriendSettingAdapter({
          entry,
          fetcher,
          save,
          kind: "favorite",
        }),
        "friend.buddy": queuedFriendSettingAdapter({
          entry,
          fetcher,
          save,
          kind: "buddy",
        }),
        "friend.request": queuedFriendRequestAdapter({ entry, fetcher, save }),
        "friend.response": queuedFriendResponseAdapter({
          entry,
          fetcher,
          save,
        }),
        "battle.start": queuedBattleStartAdapter({ entry, getBoss, save }),
        "battle.attack": queuedBattleAttackAdapter({ entry, save, now }),
        "battle.heal": queuedBattleHealAdapter({ entry }),
        "business.start": queuedBusinessRunAdapter({
          entry,
          getCatalogue: getBusinessCatalogue,
        }),
        "floor.start": queuedFloorRunAdapter({ entry }),
        ...Object.fromEntries(
          ["auto", "raid"].map((mode) => [
            `${mode}.start`,
            queuedBattleSeriesAdapter({
              entry,
              mode,
              getBoss,
              save,
              refresh: (options) => refreshAutoDamageLimit(entry, options),
              configure: (settings, state) =>
                configureAutoGoal(entry, settings, state),
              matches: (settings, state) =>
                autoGoalMatches(entry, settings, state),
            }),
          ]),
        ),
        "invitation.accept": queuedInvitationAdapter({
          entry,
          now,
          save,
          accept: (id, allowed, expected, beforeSend) =>
            acceptInvitation(entry, id, allowed, expected, beforeSend),
          refresh: () => refreshInvitations(entry, true),
        }),
        "battle.buy": queuedBattlePurchaseAdapter({
          entry,
          readWallet: async (currency) =>
            (await gameJson(entry.credential, "/api/me"))?.wallet?.[currency],
        }),
        "work.booster": queuedWorkBoosterAdapter({ entry }),
        "energy.booster": queuedEnergyBoosterAdapter({ entry, fetcher, save }),
        "work.start": queuedWorkRunAdapter({ entry }),
        "character.start": queuedCharacterRunAdapter({ entry }),
        "subscription.start": queuedSubscriptionAdapter({
          entry,
          getBoss,
          now,
          refresh: () => refreshInvitations(entry, true),
        }),
      },
      persist: (items) => {
        entry.queuedActions = items;
        save(entry);
        return !entry.storageFailed;
      },
      now,
      random,
      blockedBy: queueBlockedBy,
      retainIds: () =>
        [
          entry.workFarm.getSnapshot().run?.queueId,
          entry.characterUpgrade.run?.queueId,
          entry.businessHelper.run?.queueId,
          entry.floorRunner.getSnapshot().queueId,
          entry.auto.getSnapshot().queueId,
          entry.pausedAuto?.checkpoint?.queueId,
          entry.raidSubscription.getSnapshot().checkpoint?.auto?.queueId,
          entry.raidWorker.getSnapshot().queueId,
          entry.raidSubscription.getSnapshot().queueId,
        ].filter((id) => typeof id === "string"),
      canSettle: () => !closed && !entry.storageFailed,
      ready: () => {
        const deadline = queueNotBefore(entry);
        return deadline != null && now() >= deadline;
      },
      eligible: (job) =>
        job.type === "character.start"
          ? job.status === "reconciling" ||
            (!entry.characterBatch.running() && !entry.characterUpgrade.pending)
          : job.type === "subscription.start"
            ? job.status === "reconciling" ||
              (!entry.raidSubscription.getSnapshot().enabled &&
                !entry.raidSubscription.getSnapshot().checkpoint)
            : job.type === "work.start"
              ? job.status === "reconciling" ||
                (!["running", "paused"].includes(
                  entry.workFarm.getSnapshot().run?.status,
                ) &&
                  !entry.workFarm.getSnapshot().manualPending &&
                  !entry.workFarm.getSnapshot().run?.pending)
              : job.type === "floor.start"
                ? job.status === "reconciling" ||
                  (entry.floorRunner.getSnapshot().status !== "running" &&
                    !entry.floorActions.hasOtherWork())
                : ["auto.start", "raid.start"].includes(job.type)
                  ? job.status === "reconciling" ||
                    (!entry.auto.getSnapshot().enabled &&
                      !entry.collector.running() &&
                      entry.businessHelper.run?.status !== "paused" &&
                      !entry.pausedAuto &&
                      !entry.raidWorker.getSnapshot().enabled &&
                      !entry.raidWorker.getSnapshot().userPaused &&
                      !entry.controller.getSnapshot().pendingInvitation &&
                      (job.type === "auto.start" ||
                        entry.controller.getSnapshot().battle?.status !==
                          "active"))
                  : job.type === "business.start"
                    ? job.status === "reconciling" ||
                      (!entry.auto.getSnapshot().enabled &&
                        !entry.collector.running() &&
                        entry.businessHelper.run?.status !== "paused" &&
                        !entry.raidWorker.getSnapshot().enabled &&
                        !entry.raidWorker.getSnapshot().userPaused &&
                        !entry.pausedAuto &&
                        entry.goal.getSnapshot()?.status !== "active" &&
                        entry.controller.getSnapshot().battle?.status !==
                          "active" &&
                        !entry.controller.getSnapshot().pendingInvitation)
                    : job.type === "invitation.accept"
                      ? job.status === "reconciling" ||
                        entry.queueBattleDispatch ||
                        job.args.expiresAt <= now() ||
                        (!entry.auto.getSnapshot().enabled &&
                          !entry.collector.running() &&
                          !entry.raidWorker.getSnapshot().enabled &&
                          !entry.pausedAuto &&
                          !entry.raidWorker.getSnapshot().userPaused &&
                          entry.controller.getSnapshot().battle?.status !==
                            "active" &&
                          !entry.controller.getSnapshot().pendingInvitation)
                      : ["battle.attack", "battle.heal", "battle.buy"].includes(
                            job.type,
                          )
                        ? job.status === "reconciling" ||
                          entry.queueBattleDispatch ||
                          ((["battle.heal", "battle.buy"].includes(job.type) ||
                            (!entry.auto.getSnapshot().enabled &&
                              !entry.collector.running() &&
                              !entry.raidWorker.getSnapshot().enabled &&
                              !entry.pausedAuto &&
                              !entry.raidWorker.getSnapshot().userPaused)) &&
                            (entry.controller.getSnapshot().battle?.id !==
                              job.args.battleId ||
                              entry.controller.getSnapshot().battle?.status !==
                                "active" ||
                              now() >=
                                (entry.controller.getSnapshot().battle
                                  ?.readyAt ?? 0)))
                        : job.type === "battle.start"
                          ? job.status === "reconciling" ||
                            entry.queueBattleDispatch ||
                            (!entry.auto.getSnapshot().enabled &&
                              !entry.collector.running() &&
                              !entry.raidWorker.getSnapshot().enabled &&
                              !entry.pausedAuto &&
                              !entry.raidWorker.getSnapshot().userPaused &&
                              entry.controller.getSnapshot().battle?.status !==
                                "active" &&
                              !entry.controller.getSnapshot().pendingInvitation)
                          : job.type === "work.booster"
                            ? (entry.queueActiveBooster ||
                                entry.workFarm.canSuspendForManual()) &&
                              (job.status === "reconciling" ||
                                (!entry.auto.getSnapshot().enabled &&
                                  !entry.collector.running() &&
                                  !entry.raidWorker.getSnapshot().enabled &&
                                  entry.controller.getSnapshot().battle
                                    ?.status !== "active" &&
                                  !entry.controller.getSnapshot()
                                    .pendingInvitation))
                            : job.status === "reconciling" ||
                              job.type === "friend.remove" ||
                              job.type === "friend.request" ||
                              job.type === "friend.response" ||
                              job.type === "friend.favorite" ||
                              job.type === "friend.buddy" ||
                              job.type === "subscription.start" ||
                              job.type === "character.start" ||
                              job.type === "stash.craft" ||
                              job.args.action === "buy" ||
                              entry.controller.getSnapshot().battle?.status !==
                                "active",
      onAttempt: () => {
        actionQueueReadyAt = now() + 1000;
        currentReservation = { until: actionQueueReadyAt };
        return currentReservation;
      },
      runInContext: (job, reconcile, callback, reservation, canDispatch) => {
        const run = () =>
          requestPriority.run(job, reconcile, callback, reservation);
        return queueActionGate
          ? queueActionGate.run(
              job,
              reconcile,
              entry.credential,
              run,
              canDispatch,
            )
          : run();
      },
      onResult: (result) => {
        const refill = entry.energyBooster.pending;
        if (
          refill?.phase === "purchased" &&
          entry.queuedActions.some(
            (job) => job.id === refill.id && job.cancelRequested,
          )
        ) {
          entry.energyBooster.pending = null;
          save(entry);
          if (entry.storageFailed)
            throw failure(503, "automation_storage_unavailable");
        }
        if (Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0)
          actionQueueReadyAt = Math.max(
            actionQueueReadyAt,
            now() + result.retryAfterMs,
          );
        if (result.reason === "Ожидаем игру.") {
          const delay = retryDelay(actionQueueFailures++, random);
          actionQueueReadyAt = Math.max(
            actionQueueReadyAt,
            now() + delay,
            now() + (result.retryAfterMs ?? 0),
          );
        } else if (result.status === "completed") actionQueueFailures = 0;
        try {
          ensureLease();
          store.setQueueCooldown?.(
            actionQueueReadyAt,
            actionQueueFailures,
            owner,
            now(),
          );
        } catch (error) {
          for (const actor of actors.values()) actor.storageFailed = true;
          entry.storageFailed = true;
          throw error;
        }
      },
      allowed: (job) => {
        try {
          ensureLease();
        } catch {
          entry.storageFailed = true;
          return false;
        }
        if (
          !closed &&
          !entry.storageFailed &&
          entry.credential &&
          accountHealth(entry.credential)?.status !== "credentials_invalid" &&
          startedQueueActor(job)
        )
          return true;
        return (
          !closed &&
          !entry.storageFailed &&
          Boolean(entry.credential) &&
          (!entry.stashCraft.pending ||
            entry.stashCraft.pending.id === job.id) &&
          (!entry.energyBooster.pending ||
            entry.energyBooster.pending.id === job.id) &&
          accountHealth(entry.credential)?.status !== "credentials_invalid" &&
          entry.collector.idleForPriority() &&
          (!entry.assistant.projection().uncertain ||
            entry.assistant.queuedState().pending?.queueId === job.id) &&
          (!entry.manualBattle.pending ||
            entry.manualBattle.pending.id === job.id) &&
          (!entry.pendingAutomation || entry.pendingAutomation.id === job.id) &&
          (![
            "battle.start",
            "battle.attack",
            "battle.heal",
            "battle.buy",
            "invitation.accept",
          ].includes(job.type) ||
            job.status === "reconciling" ||
            (!entry.equipment?.pending && canAct(entry, true))) &&
          !entry.businessHelper.run?.pendingUpgrade &&
          (entry.workFarm.canSuspend() ||
            (job.type === "work.booster" &&
              (entry.queueActiveBooster ||
                entry.workFarm.canReconcileManual()))) &&
          !entry.characterBatch.running() &&
          !floorBlocksQueue(job) &&
          !entry.raidSubscription.getSnapshot().checkpoint &&
          (!entry.controller.getSnapshot().pending ||
            ([
              "battle.start",
              "battle.attack",
              "battle.heal",
              "battle.buy",
              "invitation.accept",
            ].includes(job.type) &&
              entry.queueBattleDispatch))
        );
      },
    });
    let savedGoal = JSON.stringify(entry.goal.exportState());
    entry.unsubscribers = [entry.controller, entry.auto].map((source) =>
      source.subscribe(() => save(entry)),
    );
    entry.unsubscribers.push(
      entry.goal.subscribe(() => {
        const next = JSON.stringify(entry.goal.exportState());
        if (next !== savedGoal) {
          savedGoal = next;
          save(entry);
        }
      }),
    );
    entry.restoring = false;
    // A crash after floor.stop was persisted but before its suspended workers
    // were discarded must not revive that floor-owned work after Buddy exits.
    const savedCheckpoint = entry.raidSubscription.getSnapshot().checkpoint;
    if (savedCheckpoint?.autoCancelled && entry.pausedAuto) {
      entry.pausedAuto = null;
      save(entry);
    }
    if (savedCheckpoint?.workCancelled && entry.workFarm.running())
      entry.workFarm.stop();
    if (
      savedCheckpoint?.businessCancelled &&
      (entry.collector.running() ||
        entry.businessHelper.run?.status === "paused") &&
      !entry.collector.discardSuspended()
    )
      entry.storageFailed = true;
    if (
      savedCheckpoint?.raidCancelled &&
      (entry.raidWorker.getSnapshot().enabled ||
        entry.raidWorker.getSnapshot().userPaused) &&
      !entry.raidWorker.discardSuspended()
    )
      entry.storageFailed = true;
    if (
      savedCheckpoint?.floorOwned &&
      entry.floorRunner.getSnapshot().status !== "running"
    ) {
      try {
        entry.floorActions.stopOwned(savedCheckpoint.floorTarget);
        entry.raidSubscription.discardFloorCheckpoint();
      } catch {
        entry.storageFailed = true;
      }
    }
    actors.set(playerId, entry);
    if (migration.changed) save(entry);
    if (
      entry.credential &&
      (entry.characterBatch.running() || entry.characterBatch.recovering())
    )
      entry.characterBatch.resume();
    return entry;
  }
  async function actor(playerId) {
    if (actors.has(playerId)) return actors.get(playerId);
    return createActor(playerId, store.read(playerId));
  }
  async function refreshPvp(entry) {
    entry.pvp = { ...entry.pvp, pending: true, error: false };
    save(entry);
    try {
      let id =
        entry.pvp.battle?.status === "active" &&
        (entry.pvp.battle.expiresAt == null ||
          entry.pvp.battle.expiresAt > now())
          ? entry.pvp.battle.id
          : null;
      if (!id)
        id = (await gameJson(entry.credential, "/api/combat"))?.activeBattle
          ?.battleId;
      const battle =
        typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id)
          ? normalizePvpBattle(
              await gameJson(entry.credential, `/api/combat/battles/${id}`),
              id,
              now(),
            )
          : null;
      entry.pvp = { battle, pending: false, error: false };
    } catch {
      entry.pvp = { ...entry.pvp, pending: false, error: true };
    }
    save(entry);
  }
  async function discover(entry, me) {
    if (!entry.controller.getSnapshot().boss && me.activeBossBattle) {
      const ref = me.activeBossBattle;
      if (
        positive(ref.bossId) &&
        typeof ref.battleId === "string" &&
        /^[A-Za-z0-9_-]+$/.test(ref.battleId)
      ) {
        const boss = await getBoss(ref.bossId);
        if (boss) {
          entry.controller.syncExternalBattle(
            boss,
            { ...ref, status: "active" },
            entry.controller.getSnapshot(),
          );
          await entry.controller.refresh();
        }
      }
    }
  }
  async function launch(entry, hint) {
    // Launch references are routing hints, never trusted battle state. Confirm
    // against the authenticated boss summary before adopting any browser input.
    // Background discovery is a read. Let it finish instead of reporting an
    // automation conflict during page/session restoration.
    if (entry.invitationDiscoveryPromise)
      await entry.invitationDiscoveryPromise;
    ensureLease();
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    if (entry.busy || entry.controller.getSnapshot().pending)
      throw failure(409, "automation_action_pending");
    let ref = normalizeActiveBossBattle(hint);
    if (hint != null && !ref) throw failure(400, "invalid_active_battle");
    entry.busy = true;
    try {
      if (!ref) {
        const me = await gameJson(entry.credential, "/api/me");
        if (String(me?.playerId) !== entry.playerId)
          throw failure(401, "invalid_game_identity");
        ref = normalizeActiveBossBattle(me.activeBossBattle);
      }
      if (ref) {
        const detail = await gameJson(
          entry.credential,
          `/api/bosses/${ref.bossId}`,
        );
        if (
          Number(detail?.id) !== ref.bossId ||
          !Object.hasOwn(detail, "activeBattle")
        )
          throw failure(409, "active_battle_unknown");
        const current = detail.activeBattle;
        if (current != null) {
          if (
            typeof current.battleId !== "string" ||
            !/^[A-Za-z0-9_-]+$/.test(current.battleId)
          )
            throw failure(409, "active_battle_unknown");
          // The hint may be stale: the game's current account battle wins.
          const raw = await gameJson(
            entry.credential,
            `/api/bosses/battles/${current.battleId}`,
          );
          if (
            raw?.battleId !== current.battleId ||
            Number(raw?.bossId) !== ref.bossId
          )
            throw failure(409, "active_battle_unknown");
          const state = entry.controller.getSnapshot();
          if (
            state.battle?.id !== current.battleId ||
            state.boss?.id !== ref.bossId
          ) {
            const boss = await getBoss(ref.bossId);
            if (boss) {
              entry.raidWorker.stop();
              entry.collector.stop();
              entry.auto.stop();
              entry.goal.stop();
              entry.controller.syncExternalBattle(boss, raw, state);
            }
          }
        }
      }
      if (entry.controller.getSnapshot().boss) {
        await entry.controller.refresh({ discover: true });
        await entry.controller.hydrateDetails();
      }
      save(entry);
      return snapshot(entry);
    } finally {
      entry.busy = false;
    }
  }
  async function refreshInvitations(entry, force = false) {
    if (entry.controller.getSnapshot().pendingInvitation) {
      await entry.controller.refresh();
      const battleState = entry.controller.getSnapshot();
      if (
        battleState.error &&
        (battleState.errorStatus === 429 ||
          Number.isFinite(battleState.errorRetryAfterMs))
      )
        throw Object.assign(
          failure(
            battleState.errorStatus || 503,
            "invitation_refresh_unavailable",
          ),
          { retryAfterMs: battleState.errorRetryAfterMs },
        );
      const unresolved = battleState.pendingInvitation;
      if (unresolved && unresolved.expiresAt <= now()) {
        const me = await gameJson(entry.credential, "/api/me");
        let confirmedNoBattle =
          Object.hasOwn(me, "activeBossBattle") && me.activeBossBattle === null;
        if (!Object.hasOwn(me, "activeBossBattle")) {
          try {
            const detail = await gameJson(
              entry.credential,
              `/api/bosses/${unresolved.bossId}`,
            );
            confirmedNoBattle =
              detail?.id === unresolved.bossId &&
              Object.hasOwn(detail, "activeBattle") &&
              detail.activeBattle === null;
          } catch (error) {
            if (error.status === 429 || Number.isFinite(error.retryAfterMs))
              throw error;
            // Keep the durable uncertain-accept checkpoint on read failure.
          }
        }
        if (confirmedNoBattle) entry.controller.clearExpiredInvitation();
      }
    }
    if (
      !force &&
      entry.invitations.loaded &&
      now() - entry.invitations.refreshedAt < 10000
    )
      return;
    try {
      const raw = await gameJson(entry.credential, BOSS_INVITATIONS_PATH);
      entry.invitations = {
        items: await projectBossInvitations(raw, getBoss, now()),
        loaded: true,
        refreshedAt: now(),
        notice: entry.controller.getSnapshot().pendingInvitation
          ? "Вступление не подтверждено. Проверьте состояние перед новым приглашением."
          : null,
      };
      entry.raidObservations = observeRaids(
        entry.raidObservations,
        entry.invitations.items,
        now(),
      );
      entry.raidSubscription?.observe(entry.invitations.items, true);
      save(entry);
    } catch (error) {
      entry.raidSubscription?.observe([], false);
      entry.invitations.notice =
        "Не удалось обновить приглашения. Попробуйте позже.";
      save(entry);
      const wrapped = failure(error.status || 502, "invitations_unavailable");
      if (Number.isFinite(error.retryAfterMs))
        wrapped.retryAfterMs = error.retryAfterMs;
      throw wrapped;
    }
  }
  function backgroundReadDeferred(entry) {
    const deadline = queueNotBefore(entry);
    return deadline == null || now() < deadline;
  }
  function queuedFriendReadPending(entry) {
    return entry.actionQueue
      .snapshot()
      .some(
        (job) =>
          [
            "friend.request",
            "friend.remove",
            "friend.favorite",
            "friend.buddy",
          ].includes(job.type) &&
          ["queued", "waiting", "running", "reconciling"].includes(
            job.status,
          ) &&
          ((job.type === "friend.request" &&
            entry.raidFriend.pending?.id === job.id) ||
            (job.type === "friend.remove" &&
              entry.friendRemoval.pending?.commandId === job.id) ||
            (job.reason === "Ожидаем игру." && (job.nextAt ?? 0) > now())),
      );
  }
  async function refreshPendingFriend(entry) {
    if (
      closed ||
      entry.storageFailed ||
      !entry.credential ||
      entry.busy ||
      entry.inventoryBusy ||
      entry.raidFriendRefreshing ||
      backgroundReadDeferred(entry) ||
      queuedFriendReadPending(entry) ||
      now() < entry.raidFriendRefreshAt ||
      (!["pending", "uncertain"].includes(entry.raidFriend.status) &&
        Object.keys(entry.raidFriendWatch).length === 0)
    )
      return;
    entry.raidFriendRefreshAt = now() + 60000;
    entry.raidFriendRefreshing = true;
    try {
      await refreshWatchedRaidFriends({ entry, fetcher, save });
    } catch {
      // Keep the durable checkpoint and retry reads only.
    } finally {
      entry.raidFriendRefreshing = false;
    }
  }
  async function refreshFriendSnapshot(entry) {
    const record = entry.friendSnapshot;
    if (
      closed ||
      booting ||
      !record.enabled ||
      entry.friendSnapshotRefreshing ||
      !entry.credential ||
      entry.storageFailed ||
      entry.busy ||
      entry.inventoryBusy ||
      entry.actionQueue.hasDue() ||
      backgroundReadDeferred(entry) ||
      queuedFriendReadPending(entry) ||
      entry.characterBatch.running() ||
      !entry.collector.idleForPriority() ||
      entry.controller.getSnapshot().pending ||
      now() < (record.nextAt ?? 0) ||
      accountHealth(entry.credential)?.status === "credentials_invalid"
    )
      return;
    const credential = entry.credential;
    entry.friendSnapshotRefreshing = true;
    entry.busy = true;
    entry.inventoryBusy = true;
    record.failures = (record.failures ?? 0) + 1;
    record.nextAt = now() + retryDelay(record.failures - 1, random);
    save(entry);
    try {
      if (entry.storageFailed) return;
      const items = await readFriendSnapshot({ fetcher, credential });
      if (entry.credential !== credential || closed) return;
      const previous = { ...record };
      record.items = items;
      record.updatedAt = now();
      record.failures = 0;
      record.nextAt = now() + 300000;
      if (
        Buffer.byteLength(
          JSON.stringify({ playerId: entry.playerId, value: persisted(entry) }),
        ) > 3500000
      ) {
        Object.assign(record, previous);
        record.nextAt = now() + 3600000;
        throw new Error("friends_capacity_exceeded");
      }
      save(entry);
    } catch (error) {
      logFriendError("snapshot.refresh", error);
      if (Number.isFinite(error.retryAfterMs))
        record.nextAt = Math.max(record.nextAt, now() + error.retryAfterMs);
      save(entry);
    } finally {
      entry.inventoryBusy = false;
      entry.busy = false;
      entry.friendSnapshotRefreshing = false;
    }
  }
  async function refreshPendingFriendRemoval(entry) {
    const pending = entry.friendRemoval?.pending;
    if (
      closed ||
      entry.storageFailed ||
      !entry.credential ||
      !pending ||
      entry.busy ||
      entry.inventoryBusy ||
      entry.friendRemovalRefreshing ||
      backgroundReadDeferred(entry) ||
      now() < (entry.friendRemoval.nextCheckAt ?? 0) ||
      accountHealth(entry.credential)?.status === "credentials_invalid" ||
      entry.actionQueue
        .snapshot()
        .some(
          (job) =>
            job.type === "friend.remove" &&
            ["queued", "waiting", "running", "reconciling"].includes(
              job.status,
            ),
        )
    )
      return;
    entry.friendRemovalRefreshing = true;
    entry.busy = true;
    entry.inventoryBusy = true;
    entry.friendRemoval.failures = (entry.friendRemoval.failures ?? 0) + 1;
    entry.friendRemoval.nextCheckAt =
      now() + retryDelay(entry.friendRemoval.failures - 1, random);
    save(entry);
    try {
      if (!entry.storageFailed)
        await reconcileFriendRemoval({ entry, fetcher, save });
    } catch (error) {
      // Only reads are retried; the uncertain deletion is never sent again.
      if (Number.isFinite(error.retryAfterMs) && entry.friendRemoval.pending) {
        entry.friendRemoval.nextCheckAt = Math.max(
          entry.friendRemoval.nextCheckAt,
          now() + error.retryAfterMs,
        );
        save(entry);
      }
    } finally {
      entry.friendRemovalRefreshing = false;
      entry.inventoryBusy = false;
      entry.busy = false;
    }
  }
  function discoverInvitations(entry) {
    const state = entry.controller.getSnapshot();
    if (
      closed ||
      entry.storageFailed ||
      !entry.credential ||
      entry.busy ||
      entry.inventoryBusy ||
      state.pending ||
      state.pendingInvitation ||
      backgroundReadDeferred(entry) ||
      now() < entry.invitationDiscoveryAt ||
      accountHealth(entry.credential)?.status === "credentials_invalid"
    )
      return;
    entry.invitationDiscoveryAt = now() + INVITATION_DISCOVERY_INTERVAL_MS;
    entry.busy = true;
    const discovery = refreshInvitations(entry, true)
      .catch(() => {
        // Preserve observed history and wait for the next read. Never retry a mutation.
      })
      .finally(() => {
        entry.busy = false;
        if (entry.invitationDiscoveryPromise === discovery)
          entry.invitationDiscoveryPromise = null;
      });
    entry.invitationDiscoveryPromise = discovery;
  }
  async function acceptInvitation(
    entry,
    invitationId,
    allowed = () => true,
    expected = null,
    beforeSend = () => true,
  ) {
    if (
      typeof invitationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(invitationId)
    )
      throw failure(400, "invalid_invitation");
    let state = entry.controller.getSnapshot();
    if (
      state.pendingInvitation ||
      state.pending ||
      state.purchaseUncertain ||
      state.purchase
    )
      throw failure(409, "invitation_state_uncertain");
    if (state.boss && (state.needsRefresh || state.battle?.status === "active"))
      await entry.controller.refresh();
    state = entry.controller.getSnapshot();
    if (
      state.needsRefresh ||
      state.battle?.status === "active" ||
      state.medicineOpen
    )
      throw failure(409, "active_battle_exists");
    const me = await gameJson(entry.credential, "/api/me");
    await refreshInvitations(entry, true);
    const invitation = entry.invitations.items.find(
      (item) => item.invitationId === invitationId,
    );
    if (!invitation?.available || invitation.expiresAt <= now())
      throw failure(409, "invitation_unavailable");
    if (
      expected &&
      ((expected.leaderPlayerId != null &&
        invitation.leaderPlayerId !== expected.leaderPlayerId) ||
        (expected.inviterPlayerId != null &&
          invitation.inviterPlayerId !== expected.inviterPlayerId) ||
        invitation.bossId !== expected.bossId ||
        invitation.battleId !== expected.battleId)
    )
      throw failure(409, "invitation_identity_changed");
    if (expected && entry.raidSubscription.getSnapshot().mode === "buddy") {
      if (!positive(expected.inviterPlayerId))
        throw failure(409, "invitation_identity_changed");
      const status = await readRaidFriendStatus({
        fetcher,
        credential: entry.credential,
        playerId: expected.inviterPlayerId,
        includeIncoming: false,
      });
      if (status !== "friend") throw failure(409, "friend_not_found");
    }
    const boss = await getBoss(invitation.bossId);
    if (!boss) throw failure(404, "unknown_boss");
    // /api/me omits activeBossBattle in the current game response. The boss
    // detail explicitly returns activeBattle:null when this boss has no fight.
    let activeBossBattle = me.activeBossBattle;
    if (!Object.hasOwn(me, "activeBossBattle")) {
      const detail = await gameJson(
        entry.credential,
        `/api/bosses/${invitation.bossId}`,
      );
      if (
        Number(detail?.id) !== invitation.bossId ||
        !Object.hasOwn(detail, "activeBattle")
      )
        throw failure(409, "active_battle_unknown");
      if (
        detail.activeBattle !== null &&
        (typeof detail.activeBattle?.battleId !== "string" ||
          !detail.activeBattle.battleId)
      )
        throw failure(409, "active_battle_unknown");
      activeBossBattle =
        detail.activeBattle === null
          ? null
          : {
              battleId: detail.activeBattle.battleId,
              bossId: invitation.bossId,
            };
    }
    if (activeBossBattle != null) {
      if (
        activeBossBattle.battleId !== invitation.battleId ||
        Number(activeBossBattle.bossId) !== invitation.bossId
      )
        throw failure(409, "active_battle_exists");
      const raw = await gameJson(
        entry.credential,
        `/api/bosses/battles/${invitation.battleId}`,
      );
      if (!entry.controller.adoptJoinedInvitation(boss, raw))
        throw failure(409, "invitation_state_uncertain");
    } else {
      if (!allowed() || !canAct(entry, Boolean(entry.queueBattleDispatch)))
        throw failure(409, "raid_stopped");
      const goal = entry.goal.getSnapshot();
      if (
        goal &&
        (goal.boss.id !== invitation.bossId || goal.status !== "active")
      )
        entry.goal.reset();
      await entry.controller.acceptInvitation(boss, invitation, { beforeSend });
      if (
        entry.controller.getSnapshot().pendingInvitation ||
        entry.controller.getSnapshot().needsRefresh ||
        entry.controller.getSnapshot().battle?.id !== invitation.battleId ||
        !entry.controller.getSnapshot().invitationOnly
      )
        throw failure(409, "invitation_state_uncertain");
    }
    entry.invitations.items = entry.invitations.items.filter(
      (item) => item.invitationId !== invitationId,
    );
    entry.invitations.notice = "Приглашение принято. Бой открыт.";
    save(entry);
  }
  async function identify(authorization) {
    if (closed) throw failure(503, "automation_unavailable");
    ensureLease();
    if (
      typeof authorization !== "string" ||
      authorization.length > 16384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      throw failure(401, "game_session_required");
    const hash = createHash("sha256").update(authorization).digest("hex");
    const cached = identities.get(hash);
    if (cached?.until > now()) {
      const entry = await actor(cached.playerId);
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      // A different verified session may have replaced this actor's saved
      // credential. Never let an old cached token operate using the new one.
      if (
        entry.credential === authorization &&
        accountHealth(authorization)?.status !== "credentials_invalid"
      )
        return entry;
    }
    if (loading.has(hash)) return loading.get(hash);
    const promise = (async () => {
      // Account identity comes only from the authenticated upstream, never JWT claims/caller IDs.
      const me = await (identifyPlayer
        ? identifyPlayer(authorization)
        : gameJson(authorization, "/api/me"));
      if (!positive(me?.playerId)) throw failure(401, "invalid_game_identity");
      const playerId = String(me.playerId);
      const entry = await actor(playerId);
      entry.credential = authorization;
      entry.player = {
        playerId: me.playerId,
        nickname:
          typeof me.nickname === "string" ? me.nickname.slice(0, 80) : "Игрок",
      };
      save(entry);
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      identities.set(hash, { playerId, until: now() + 5 * 60 * 1000 });
      if (identities.size > 500)
        identities.delete(identities.keys().next().value);
      if (entry.needsInitialReconcile) {
        entry.needsInitialReconcile = false;
        if (!entry.raidSubscription.getSnapshot().checkpoint)
          await entry.controller.refresh();
      }
      if (!entry.raidSubscription.getSnapshot().checkpoint)
        await discover(entry, me);
      if (entry.needsPvpDiscovery) {
        entry.needsPvpDiscovery = false;
        await refreshPvp(entry);
      }
      return entry;
    })();
    loading.set(hash, promise);
    try {
      return await promise;
    } finally {
      loading.delete(hash);
    }
  }
  function resolvedAutoGoal(settingsInput, state) {
    if (!state.boss || settingsInput.bossId !== state.boss.id)
      throw failure(400, "goal_boss_mismatch");
    const resolved = resolveBossGoal(settingsInput, state.boss);
    return {
      ...resolved,
      targetCount: ["time", "drops"].includes(resolved.kind)
        ? null
        : resolved.targetCount,
      maxAttempts:
        resolved.maxAttempts ??
        (resolved.kind === "battles" && !resolved.countWins
          ? resolved.targetCount
          : null),
    };
  }
  function autoGoalMatches(entry, settingsInput, state) {
    const settings = resolvedAutoGoal(settingsInput, state);
    const previous = entry.goal.exportState()?.settings;
    return Boolean(
      entry.goal.getSnapshot()?.status === "active" &&
      previous &&
      [
        "bossId",
        "kind",
        "targetCount",
        "durationHours",
        "maxAttempts",
        "countWins",
      ].every(
        (key) =>
          (previous[key] ?? (key === "countWins" ? false : null)) ===
          (settings[key] ?? (key === "countWins" ? false : null)),
      ) &&
      JSON.stringify(previous.items) === JSON.stringify(settings.items),
    );
  }
  function configureAutoGoal(entry, settingsInput, state) {
    if (settingsInput == null) return;
    if (entry.auto.getSnapshot().enabled)
      throw failure(409, "automation_controls_the_battle");
    const settings = resolvedAutoGoal(settingsInput, state);
    if (!autoGoalMatches(entry, settingsInput, state))
      entry.goal.configure(settings);
  }
  function tryResumePausedAuto(entry) {
    const paused = entry.pausedAuto;
    const goal = entry.goal.getSnapshot();
    if (paused && goal && goal.status !== "active") {
      entry.pausedAuto = null;
      save(entry);
      return;
    }
    if (
      !paused?.resumeRequested ||
      now() < (paused.nextAttemptAt ?? 0) ||
      entry.storageFailed ||
      closed ||
      !entry.credential ||
      entry.busy ||
      entry.inventoryBusy ||
      entry.controller.getSnapshot().pending ||
      entry.equipment?.pending ||
      entry.workFarm.getSnapshot().manualPending ||
      entry.floorRunner.getSnapshot().status === "running" ||
      entry.raidWorker.getSnapshot().enabled ||
      entry.collector.running() ||
      entry.raidSubscription.getSnapshot().checkpoint ||
      entry.characterBatch.running() ||
      entry.controller.getSnapshot().purchase ||
      entry.controller.getSnapshot().purchaseUncertain ||
      entry.actionQueue
        .snapshot()
        .some(
          (job) =>
            job.type === "battle.buy" &&
            ["queued", "waiting", "running", "reconciling"].includes(
              job.status,
            ),
        )
    )
      return;
    const state = entry.controller.getSnapshot();
    if (state.boss?.id !== paused.checkpoint?.bossId) return;
    paused.nextAttemptAt = now() + 10000;
    save(entry);
    if (entry.storageFailed) return;
    if (
      entry.auto.start({
        checkpoint: paused.checkpoint,
        resumeAt: paused.checkpoint.nextAttackAt,
      })
    ) {
      entry.pausedAuto = null;
      save(entry);
    }
  }
  async function commandInner(entry, input) {
    if (
      !input ||
      typeof input !== "object" ||
      typeof input.id !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(input.id) ||
      !commands.has(input.command) ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      throw failure(400, "invalid_automation_command");
    ensureLease();
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    if (input.command === "friends.respond") {
      if (input.expectedVersion !== entry.version)
        throw failure(409, "automation_state_changed");
      if (entry.receipts.includes(input.id))
        throw failure(409, "automation_command_already_received");
      const adapter = queuedFriendResponseAdapter({ entry, fetcher, save });
      let args;
      try {
        args = adapter.validate(input.args);
      } catch {
        throw failure(400, "invalid_friend_request_response");
      }
      if (
        entry.friendResponse.pending ||
        entry.actionQueue
          .snapshot()
          .some(
            (job) =>
              job.type === "friend.response" &&
              job.args?.playerId === args.playerId &&
              ["queued", "waiting", "running", "reconciling"].includes(
                job.status,
              ),
          )
      )
        throw failure(409, "friend_response_pending");
      const job = { id: input.id, args };
      const blocked = entry.priorityActionBlockedBy(job);
      if (blocked && blocked !== "rate")
        throw failure(409, "automation_action_pending");
      entry.busy = true;
      entry.friendResponse.pending = job;
      entry.receipts = [...entry.receipts.slice(-127), input.id];
      save(entry);
      try {
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        const result = await adapter.execute(job, {
          canDispatch: () => !closed && !entry.storageFailed,
        });
        if (
          result.status === "completed" ||
          result.status === "failed" ||
          result.status === "retry"
        ) {
          entry.friendResponse.pending = null;
          save(entry);
        }
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        if (result.status !== "completed")
          throw failure(409, result.reason || "friend_response_unavailable");
        return snapshot(entry);
      } finally {
        entry.busy = false;
      }
    }
    if (input.command === "energy.booster.use") {
      if (input.expectedVersion !== entry.version)
        throw failure(409, "automation_state_changed");
      if (entry.receipts.includes(input.id))
        throw failure(409, "automation_command_already_received");
      const adapter = queuedEnergyBoosterAdapter({ entry, fetcher, save });
      let args;
      try {
        args = adapter.validate(input.args);
      } catch {
        throw failure(400, "invalid_energy_booster");
      }
      const pending = entry.energyBooster.pending;
      if (pending && pending.type !== args.type)
        throw failure(409, "energy_booster_pending");
      const id = pending?.id ?? input.id;
      const job = { id, args };
      const blocked = entry.priorityActionBlockedBy(job);
      if (blocked && blocked !== "rate")
        throw failure(409, "automation_action_pending");
      entry.busy = true;
      entry.receipts = [...entry.receipts.slice(-127), input.id];
      save(entry);
      try {
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        let result = pending
          ? await adapter.reconcile(job)
          : await adapter.execute(job, {
              canDispatch: () => !closed && !entry.storageFailed,
            });
        if (
          result.status === "retry" &&
          entry.energyBooster.pending?.phase === "purchased"
        )
          result = await adapter.execute(job, {
            canDispatch: () => !closed && !entry.storageFailed,
          });
        if (result.status !== "completed")
          throw failure(409, result.reason || "energy_booster_unavailable");
        return snapshot(entry);
      } finally {
        entry.busy = false;
      }
    }
    if (input.command === "queue.enqueue") {
      if (
        ![
          "inventory",
          "stash.craft",
          "friend.remove",
          "friend.favorite",
          "friend.buddy",
          "friend.request",
          "friend.response",
          "work.booster",
          "energy.booster",
          "work.start",
          "character.start",
          "subscription.start",
          "battle.start",
          "battle.attack",
          "battle.heal",
          "battle.buy",
          "invitation.accept",
          "business.start",
          "floor.start",
          "auto.start",
          "raid.start",
        ].includes(input.args?.type)
      )
        throw failure(400, "invalid_queue_type");
      const knownJob = entry.actionQueue
        .snapshot()
        .find((job) => job.id === input.id);
      const runningRaid = entry.raidWorker.getSnapshot();
      if (
        input.args.type === "raid.start" &&
        !knownJob &&
        (runningRaid.enabled || runningRaid.userPaused) &&
        positive(input.args.action?.settings?.bossId) &&
        runningRaid.bossId === input.args.action.settings.bossId
      )
        throw failure(409, "raid_boss_already_active");
      if (entry.receipts.includes(input.id) && !knownJob)
        throw failure(409, "automation_command_already_received");
      const previousReceipts = entry.receipts;
      if (!entry.receipts.includes(input.id))
        entry.receipts = [...entry.receipts.slice(-127), input.id];
      try {
        let action = input.args.action;
        const dependsOn = input.args.dependsOn ?? [];
        if (
          !Array.isArray(dependsOn) ||
          dependsOn.length > 10 ||
          dependsOn.some((id) => {
            const dependency = entry.actionQueue
              .snapshot()
              .find((job) => job.id === id);
            return (
              !dependency ||
              [
                "work.start",
                "character.start",
                "business.start",
                "floor.start",
                "auto.start",
                "raid.start",
                "subscription.start",
              ].includes(dependency.type)
            );
          })
        )
          throw failure(400, "invalid_action_queue_dependency");
        if (input.args.type === "invitation.accept") {
          action =
            knownJob?.type === "invitation.accept"
              ? knownJob.args
              : entry.invitations.items.find(
                  (item) =>
                    item.invitationId === input.args.action?.invitationId,
                );
          if (!knownJob && (!action?.available || action.expiresAt <= now()))
            throw failure(409, "invitation_unavailable");
        }
        const job = entry.actionQueue.add({
          id: input.id,
          type: input.args.type,
          args: action,
          dependsOn,
          priority:
            input.args.type === "invitation.accept"
              ? 60
              : ["work.start", "character.start"].includes(input.args.type)
                ? 20
                : [
                      "business.start",
                      "auto.start",
                      "raid.start",
                      "floor.start",
                      "subscription.start",
                    ].includes(input.args.type)
                  ? 15
                  : 30,
        });
        // Equivalent clicks may reuse an existing job; their own receipt must
        // still be durable before the response is returned.
        if (
          entry.receipts !== previousReceipts &&
          (knownJob || job.id !== input.id)
        )
          save(entry);
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
      } catch (error) {
        entry.receipts = previousReceipts;
        throw failure(entry.storageFailed ? 503 : 400, error.message);
      }
      if (input.args.type === "battle.buy") {
        entry.controller.cancelPurchase();
        if (entry.pausedAuto?.purchasePause) {
          entry.pausedAuto.resumeRequested = true;
          entry.pausedAuto.nextAttemptAt = 0;
          save(entry);
        }
      }
      return snapshot(entry);
    }
    if (input.command === "queue.move") {
      if (entry.receipts.includes(input.id)) return snapshot(entry);
      if (input.expectedVersion !== entry.version)
        throw failure(409, "automation_state_changed");
      if (
        typeof input.args?.id !== "string" ||
        !["up", "down"].includes(input.args?.direction)
      )
        throw failure(400, "invalid_queue_move");
      const previousReceipts = entry.receipts;
      entry.receipts = [...entry.receipts.slice(-127), input.id];
      try {
        if (!entry.actionQueue.moveSeries(input.args.id, input.args.direction))
          throw failure(409, "queue_move_unavailable");
      } catch (error) {
        entry.receipts = previousReceipts;
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        throw error;
      }
      return snapshot(entry);
    }
    if (input.command === "queue.dismiss") {
      if (typeof input.args?.id !== "string")
        throw failure(400, "invalid_queue_id");
      try {
        entry.actionQueue.dismiss(input.args.id);
      } catch (error) {
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        throw error;
      }
      return snapshot(entry);
    }
    if (input.command === "queue.cancel") {
      if (
        entry.energyBooster.pending?.id === input.args?.id &&
        entry.energyBooster.pending.phase === "purchased"
      ) {
        entry.energyBooster.pending = null;
        save(entry);
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
      }
      if (typeof input.args?.id !== "string")
        throw failure(400, "invalid_queue_id");
      try {
        entry.actionQueue.stop(input.args.id);
      } catch (error) {
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        throw error;
      }
      if (
        entry.floorRunner.getSnapshot().queueId === input.args.id &&
        entry.floorRunner.getSnapshot().status !== "stopped"
      ) {
        entry.floorRunner.stop();
        entry.raidSubscription.discardFloorCheckpoint();
      }
      if (
        entry.workFarm.getSnapshot().run?.queueId === input.args.id &&
        ["running", "paused"].includes(entry.workFarm.getSnapshot().run?.status)
      )
        entry.workFarm.stop();
      if (entry.characterUpgrade.run?.queueId === input.args.id)
        entry.characterBatch.stop();
      if (
        entry.raidSubscription.getSnapshot().mode === "subscription" &&
        entry.raidSubscription.getSnapshot().queueId === input.args.id
      )
        entry.raidSubscription.stop();
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      return snapshot(entry);
    }
    if (entry.stashCraft.pending && !safeCommands.has(input.command))
      throw failure(409, "automation_action_pending");
    // Do not queue another upgrade behind an active or uncertain operation.
    if (
      (entry.characterBatch.running() || entry.characterUpgrade.pending) &&
      ["character.upgrade", "character.start", "character.startAll"].includes(
        input.command,
      )
    ) {
      throw failure(409, "character_batch_running");
    }
    if (
      entry.manualBattle.pending &&
      [
        "open",
        "start",
        "next",
        "attack",
        "auto.start",
        "raid.start",
        "invitations.accept",
        "goal.configure",
        "goal.reset",
      ].includes(input.command)
    )
      throw failure(409, "battle_start_uncertain");
    if (
      entry.pendingAutomation &&
      [
        "auto.start",
        "raid.start",
        "goal.configure",
        "goal.reset",
        "business.run.start",
      ].includes(input.command)
    )
      throw failure(409, "automation_start_pending");
    if (entry.raidFriendRefreshing && input.command.startsWith("raid.friend."))
      throw failure(409, "friend_status_pending");
    if (
      entry.characterUpgrade.pending &&
      input.command !== "character.refresh" &&
      !safeCommands.has(input.command)
    )
      throw failure(409, "character_upgrade_uncertain");
    if (entry.characterBatch.running() && !safeCommands.has(input.command))
      throw failure(409, "character_batch_running");
    if (entry.raidFriendRefreshing && input.command.startsWith("raid.friend."))
      throw failure(409, "friend_status_pending");
    if (
      entry.businessHelper.run?.pendingUpgrade &&
      ![
        "floor.stop",
        "business.run.stop",
        "business.run.pause",
        "business.run.resume",
        "friends.reconcile",
        "character.refresh",
        "character.stop",
        "character.upgrade",
        "character.start",
        "character.startAll",
        "business.select",
        "business.refresh",
        "invitations.refresh",
        "subscription.stop",
        "buddy.stop",
        "work.stop",
        "work.pause",
        "work.resume",
        "work.refresh",
        "auto.stop",
        "auto.pause",
        "auto.resume",
        "raid.stop",
        "raid.pause",
        "raid.resume",
        "goal.stop",
        "pvp.refresh",
        "inventory.refresh",
        "refresh",
      ].includes(input.command)
    )
      throw failure(409, "business_upgrade_uncertain");
    const safetyBuddySettings =
      input.command === "buddy.configure" &&
      typeof input.args?.boostersEnabled === "boolean" &&
      typeof input.args?.stashEnabled === "boolean" &&
      (!input.args.boostersEnabled || entry.buddyHelp.boostersEnabled) &&
      (!input.args.stashEnabled || entry.buddyHelp.stashEnabled) &&
      Number.isSafeInteger(input.args.fullBoosterReserve) &&
      input.args.fullBoosterReserve >= entry.buddyHelp.fullBoosterReserve &&
      Number.isSafeInteger(input.args.stashReserve) &&
      input.args.stashReserve >= entry.buddyHelp.stashReserve;
    // A command receipt is committed BEFORE action dispatch. Never replay it after a restart.
    if (entry.receipts.includes(input.id))
      throw failure(409, "automation_command_already_received");
    // Read-only refresh may coexist with another actor's in-flight action;
    // it must not reconcile an active or uncertain character operation.
    if (
      input.command === "character.refresh" &&
      (entry.busy || entry.inventoryBusy) &&
      !entry.characterUpgrade.pending &&
      !entry.characterBatch.running()
    ) {
      if (
        input.args != null &&
        (typeof input.args !== "object" || Array.isArray(input.args))
      )
        throw failure(400, "invalid_command_arguments");
      entry.receipts = [...entry.receipts.slice(-127), input.id];
      save(entry);
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      const credential = entry.credential;
      await readCharacterProfile(entry, credential);
      if (entry.credential !== credential)
        throw failure(409, "character_account_changed");
      save(entry);
      return snapshot(entry);
    }
    if (
      (entry.busy || entry.inventoryBusy) &&
      !(input.command === "buddy.set" && input.args?.enabled === false) &&
      !safetyBuddySettings &&
      ![
        "floor.stop",
        "raid.stop",
        "raid.pause",
        "raid.resume",
        "subscription.stop",
        "buddy.stop",
        "auto.stop",
        "auto.pause",
        "auto.resume",
        "goal.stop",
        "business.run.stop",
        "business.run.pause",
        "business.run.resume",
        "character.stop",
        "character.upgrade",
        "character.start",
        "character.startAll",
        "work.stop",
        "work.pause",
        "work.resume",
        "work.start",
      ].includes(input.command)
    )
      throw failure(409, "automation_command_pending");
    const durableIntent =
      input.command === "work.start" ||
      ["character.upgrade", "character.start", "character.startAll"].includes(
        input.command,
      ) ||
      (["auto.start", "raid.start"].includes(input.command) &&
        positive(input.args?.settings?.bossId)) ||
      (input.command === "business.run.start" &&
        positive(input.args?.businessId));
    if (
      !safeCommands.has(input.command) &&
      !(input.command === "buddy.set" && input.args?.enabled === false) &&
      !safetyBuddySettings &&
      !durableIntent &&
      input.expectedVersion !== entry.version
    )
      throw failure(409, "automation_state_changed");
    if (
      ["auto.pause", "auto.resume"].includes(input.command) &&
      (entry.raidWorker.getSnapshot().enabled ||
        entry.raidWorker.getSnapshot().userPaused ||
        entry.collector.running() ||
        entry.raidSubscription.getSnapshot().checkpoint)
    )
      throw failure(409, "automation_controls_the_battle");
    if (
      ["work.pause", "work.resume"].includes(input.command) &&
      entry.raidSubscription.getSnapshot().checkpoint
    )
      throw failure(409, "subscription_controls_automation");
    if (
      entry.raidSubscription.getSnapshot().checkpoint &&
      ![
        "floor.stop",
        "subscription.stop",
        "buddy.stop",
        "buddy.set",
        "buddy.order",
        "buddy.configure",
        "buddy.resolve",
        "work.stop",
        "business.run.stop",
        "raid.stop",
        "auto.stop",
        "goal.stop",
        "invitations.refresh",
        "friends.reconcile",
        "inventory.refresh",
        "character.upgrade",
        "character.start",
        "character.startAll",
        "raid.friend.check",
        "raid.friend.inspect",
        "raid.friend.refresh",
        "raid.friend.request",
        "refresh",
        "pvp.refresh",
      ].includes(input.command)
    )
      throw failure(409, "subscription_controls_automation");
    if (
      (entry.auto.getSnapshot().enabled || entry.collector.running()) &&
      ["start", "next", "attack", "invitations.accept"].includes(input.command)
    )
      throw failure(409, "automation_controls_the_battle");
    if (
      (entry.collector.running() ||
        entry.businessHelper.run?.status === "paused") &&
      [
        "goal.configure",
        "goal.reset",
        "business.save",
        "business.goal",
        "auto.start",
        "invitations.accept",
      ].includes(input.command)
    )
      throw failure(409, "business_collection_controls_the_battle");
    if (
      entry.collector.running() &&
      input.command === "open" &&
      input.args?.bossId !== entry.controller.getSnapshot().boss?.id
    )
      throw failure(409, "business_collection_controls_the_battle");
    if (
      (entry.raidWorker.getSnapshot().enabled ||
        entry.raidWorker.getSnapshot().userPaused) &&
      [
        "start",
        "next",
        "attack",
        "invitations.accept",
        "auto.start",
        "goal.configure",
        "goal.reset",
        "business.run.start",
        "business.goal",
        "medicine.use",
        "purchase.buy",
      ].includes(input.command)
    )
      throw failure(409, "raid_controls_the_battle");
    if (
      input.command === "open" &&
      entry.raidWorker.getSnapshot().enabled &&
      input.args?.bossId !== entry.raidWorker.getSnapshot().bossId
    )
      throw failure(409, "raid_controls_the_battle");
    if (
      input.command === "raid.start" &&
      (entry.auto.getSnapshot().enabled || entry.collector.running())
    )
      throw failure(409, "automation_controls_resources");
    if (
      ["equipment.weapon", "inventory.action"].includes(input.command) &&
      (entry.auto.getSnapshot().enabled ||
        entry.collector.running() ||
        entry.workFarm.running() ||
        entry.raidWorker.getSnapshot().enabled ||
        entry.controller.getSnapshot().pending)
    )
      throw failure(409, "automation_controls_equipment");
    if (
      entry.workFarm.getSnapshot().manualPending &&
      !["character.upgrade", "character.start", "character.startAll"].includes(
        input.command,
      ) &&
      !safeCommands.has(input.command)
    )
      throw failure(409, "work_booster_uncertain");
    if (
      input.command === "work.booster.use" &&
      (entry.auto.getSnapshot().enabled ||
        entry.collector.running() ||
        entry.raidWorker.getSnapshot().enabled ||
        entry.controller.getSnapshot().battle?.status === "active" ||
        entry.controller.getSnapshot().pendingInvitation ||
        entry.controller.getSnapshot().purchaseUncertain ||
        entry.controller.getSnapshot().pending)
    )
      throw failure(409, "automation_controls_resources");
    const args = input.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw failure(400, "invalid_command_arguments");
    if (
      (entry.floorRunner.getSnapshot().status === "running" ||
        entry.floorRunner.getSnapshot().phase === "launching") &&
      !safeCommands.has(input.command) &&
      ![
        "floor.stop",
        "buddy.set",
        "buddy.order",
        "buddy.configure",
        "buddy.resolve",
        "refresh",
        "hydrate",
        "invitations.refresh",
        "character.upgrade",
        "character.start",
        "character.startAll",
      ].includes(input.command)
    )
      throw failure(409, "floor_automation_controls_resources");
    if (input.command !== "raid.stop") updateGoal(entry);
    let state = entry.controller.getSnapshot();
    if (
      [
        "goal.configure",
        "goal.reset",
        "open",
        "favorites.set",
        "auto.start",
        "invitations.accept",
      ].includes(input.command) &&
      state.pending
    )
      throw failure(409, "automation_action_pending");
    const wasBusy = entry.busy;
    entry.busy = true;
    entry.receipts = [...entry.receipts.slice(-127), input.id];
    save(entry);
    try {
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      let reconciledPurchase = false;
      if (
        entry.equipment?.pending &&
        !safeCommands.has(input.command) &&
        !(input.command === "buddy.set" && input.args?.enabled === false) &&
        !safetyBuddySettings &&
        ![
          "equipment.refresh",
          "character.upgrade",
          "character.start",
          "character.startAll",
        ].includes(input.command)
      ) {
        const previous = entry.equipment.pending;
        const reconciled = await inventoryAction({
          entry,
          args: {},
          commandId: input.id,
          refreshOnly: true,
          fetcher,
          save,
          allowed: () => !closed && !entry.storageFailed,
        });
        reconciledPurchase =
          input.command === "inventory.action" &&
          args.action === "buy" &&
          previous.action === "buy" &&
          args.type === previous.type &&
          args.id === previous.entityId &&
          (args.zoneId ?? null) === (previous.zoneId ?? null) &&
          reconciled.item?.owned === true;
      }
      if (
        [
          "auto.stop",
          "auto.pause",
          "goal.stop",
          "business.run.stop",
          "business.run.pause",
        ].includes(input.command) ||
        (input.command === "raid.stop" && state.battle?.status !== "active") ||
        input.command === "raid.pause"
      )
        entry.autoStartGeneration = (entry.autoStartGeneration ?? 0) + 1;
      switch (input.command) {
        case "buddy.resolve": {
          if (!["booster", "stash"].includes(args.kind))
            throw failure(400, "invalid_buddy_resolution");
          const helper = entry.buddyHelp;
          if (args.kind === "booster") {
            const pending = helper.pending;
            if (!pending) throw failure(409, "buddy_no_pending_action");
            const response = await gameJson(
              entry.credential,
              "/api/player-interactions/booster-requests/incoming?limit=100",
            );
            if (
              !Array.isArray(response?.items) ||
              response.success === false ||
              response.partial === true ||
              response.error
            )
              throw failure(503, "buddy_read_unavailable");
            const completed = (helper.completed ?? []).filter(
              (item) =>
                item.expiresAt > now() && item.requestId !== pending.requestId,
            );
            if (completed.length >= 1000)
              throw failure(409, "buddy_history_full");
            if (pending.expiresAt > now())
              completed.push({
                requestId: pending.requestId,
                expiresAt: pending.expiresAt,
              });
            helper.completed = completed;
            helper.pending = null;
            helper.log = [
              {
                at: now(),
                playerId: pending.playerId,
                type: "booster",
                result: "acknowledged",
              },
              ...(helper.log ?? []),
            ].slice(0, 30);
          } else {
            const pending = helper.stashPending;
            if (!pending) throw failure(409, "buddy_no_pending_action");
            const response = await gameJson(
              entry.credential,
              `/api/stash/help-requests/${pending.playerId}`,
            );
            if (
              !Array.isArray(response?.items) ||
              response.success === false ||
              response.partial === true ||
              response.error ||
              !Number.isSafeInteger(response.remainingToday) ||
              response.remainingToday < 0
            )
              throw failure(503, "buddy_read_unavailable");
            const blocked = (helper.stashBlocked ?? []).filter(
              (item) =>
                !(
                  item.playerId === pending.playerId &&
                  item.setId === pending.setId &&
                  item.ingredientId === pending.ingredientId
                ),
            );
            if (blocked.length >= 1000)
              throw failure(409, "buddy_history_full");
            blocked.push({
              playerId: pending.playerId,
              setId: pending.setId,
              ingredientId: pending.ingredientId,
            });
            helper.stashBlocked = blocked;
            helper.stashPending = null;
            helper.log = [
              {
                at: now(),
                playerId: pending.playerId,
                type: "stash",
                result: "acknowledged",
              },
              ...(helper.log ?? []),
            ].slice(0, 30);
          }
          helper.notice =
            "Результат отправки остался неизвестен; повтор этой просьбы заблокирован.";
          break;
        }
        case "buddy.configure": {
          if (
            typeof args.boostersEnabled !== "boolean" ||
            !Number.isSafeInteger(args.fullBoosterReserve) ||
            args.fullBoosterReserve < 0 ||
            args.fullBoosterReserve > 10000 ||
            typeof args.stashEnabled !== "boolean" ||
            !Number.isSafeInteger(args.stashReserve) ||
            args.stashReserve < 0 ||
            args.stashReserve > 10000
          )
            throw failure(400, "invalid_buddy_settings");
          Object.assign(entry.buddyHelp, {
            boostersEnabled: args.boostersEnabled,
            fullBoosterReserve: args.fullBoosterReserve,
            stashEnabled: args.stashEnabled,
            stashReserve: args.stashReserve,
          });
          break;
        }
        case "buddy.stop": {
          for (const job of entry.actionQueue.snapshot())
            if (
              job.type === "friend.buddy" &&
              job.args.enabled &&
              [
                "queued",
                "waiting",
                "running",
                "reconciling",
                "paused",
              ].includes(job.status)
            )
              entry.actionQueue.stop(job.id);
          if (
            entry.raidSubscription.getSnapshot().mode === "buddy" &&
            !entry.raidSubscription.setBuddyFriends([])
          )
            throw failure(409, "buddy_unavailable");
          break;
        }
        case "buddy.order": {
          const subscription = entry.raidSubscription.getSnapshot();
          const current =
            subscription.mode === "buddy" ? (subscription.friendIds ?? []) : [];
          if (
            !Array.isArray(args.friendIds) ||
            args.friendIds.length !== current.length ||
            new Set(args.friendIds).size !== current.length ||
            !args.friendIds.every((id) => current.includes(id))
          )
            throw failure(400, "invalid_buddy_order");
          if (!entry.raidSubscription.setBuddyFriends(args.friendIds))
            throw failure(409, "buddy_unavailable");
          break;
        }
        case "buddy.set": {
          if (!positive(args.playerId) || typeof args.enabled !== "boolean")
            throw failure(400, "invalid_friend_player");
          const subscription = entry.raidSubscription.getSnapshot();
          if (
            (subscription.enabled || subscription.checkpoint) &&
            subscription.mode !== "buddy"
          )
            throw failure(409, "subscription_active");
          const ids =
            subscription.mode === "buddy"
              ? [...(subscription.friendIds ?? [])]
              : [];
          if (args.enabled && !ids.includes(args.playerId)) {
            const status = await readRaidFriendStatus({
              fetcher,
              credential: entry.credential,
              playerId: args.playerId,
              includeIncoming: false,
            });
            if (status !== "friend") throw failure(409, "friend_not_found");
            ids.push(args.playerId);
          }
          if (!args.enabled) {
            const index = ids.indexOf(args.playerId);
            if (index !== -1) ids.splice(index, 1);
          }
          for (const job of entry.actionQueue.snapshot())
            if (
              job.type === "friend.buddy" &&
              job.args.playerId === args.playerId &&
              [
                "queued",
                "waiting",
                "paused",
                "running",
                "reconciling",
              ].includes(job.status)
            )
              entry.actionQueue.stop(job.id);
          if (!entry.raidSubscription.setBuddyFriends(ids))
            throw failure(409, "buddy_unavailable");
          break;
        }
        case "friends.favorite": {
          if (!positive(args.playerId) || typeof args.enabled !== "boolean")
            throw failure(400, "invalid_friend_player");
          const ids = new Set(entry.preferences.favoriteFriendIds ?? []);
          if (args.enabled) {
            if (ids.size >= 1000 && !ids.has(args.playerId))
              throw failure(400, "too_many_favorites");
            const status = await readRaidFriendStatus({
              fetcher,
              credential: entry.credential,
              playerId: args.playerId,
              includeIncoming: false,
            });
            if (status !== "friend") throw failure(409, "friend_not_found");
            ids.add(args.playerId);
          } else ids.delete(args.playerId);
          entry.preferences = {
            ...entry.preferences,
            favoriteFriendIds: [...ids],
          };
          break;
        }
        case "friends.remove": {
          const buddy = entry.raidSubscription.getSnapshot();
          if (
            positive(args.playerId) &&
            buddy.mode === "buddy" &&
            (buddy.friendIds ?? []).includes(args.playerId)
          ) {
            if (
              !entry.raidSubscription.setBuddyFriends(
                buddy.friendIds.filter((id) => id !== args.playerId),
              )
            )
              throw failure(409, "buddy_unavailable");
          }
          await removeFriend({
            entry,
            playerId: args.playerId,
            commandId: input.id,
            fetcher,
            save,
            allowed: () => {
              ensureLease();
              return !closed && !entry.storageFailed;
            },
          });
          break;
        }
        case "friends.reconcile":
          await reconcileFriendRemoval({ entry, fetcher, save });
          break;
        case "floor.start":
          if (entry.floorActions.hasOtherWork())
            throw failure(409, "floor_resources_busy");
          entry.floorRunner.start();
          break;
        case "floor.stop":
          for (const job of entry.actionQueue.snapshot()) {
            if (
              job.type === "floor.start" &&
              [
                "queued",
                "waiting",
                "running",
                "reconciling",
                "paused",
              ].includes(job.status)
            )
              entry.actionQueue.stop(job.id);
          }
          if (entry.floorRunner.getSnapshot().status !== "stopped") {
            entry.floorRunner.stop();
            entry.raidSubscription.discardFloorCheckpoint();
          }
          break;
        case "character.stop":
          entry.characterBatch.stop();
          break;
        case "character.startAll": {
          if (
            !Array.isArray(args.quotes) ||
            !args.quotes.length ||
            args.quotes.length > 3 ||
            new Set(args.quotes.map((q) => q?.stat)).size !== args.quotes.length
          )
            throw failure(400, "invalid_character_upgrade");
          const profile = entry.characterUpgrade.profile;
          const quotes = args.quotes.map((expected) => {
            const quote = characterUpgradeQuote(
              profile,
              expected.stat,
              expected.amount,
            );
            if (
              !quote ||
              quote.amount !== quote.dailyRemaining ||
              [
                "stat",
                "base",
                "dailyUsed",
                "resetAt",
                "currency",
                "nextCost",
                "maxCost",
                "maxPrice",
                "amount",
              ].some((key) => quote[key] !== expected[key])
            )
              throw failure(409, "character_upgrade_quote_changed");
            return quote;
          });
          for (const currency of ["gold", "pills"]) {
            const total = quotes
              .filter((q) => q.currency === currency)
              .reduce((sum, q) => sum + q.maxPrice, 0);
            if (
              !Number.isSafeInteger(total) ||
              (total &&
                (!Number.isSafeInteger(profile.wallet[currency]) ||
                  profile.wallet[currency] < total))
            )
              throw failure(409, "character_upgrade_insufficient_funds");
          }
          entry.characterBatch.startAll(quotes);
          break;
        }
        case "character.start": {
          const profile = entry.characterUpgrade.profile;
          const quote = characterUpgradeQuote(profile, args.stat, args.amount);
          const expected = args.expected;
          if (
            !quote ||
            !expected ||
            expected.stat !== args.stat ||
            quote.base !== expected.base ||
            quote.dailyUsed !== expected.dailyUsed ||
            quote.resetAt !== expected.resetAt ||
            quote.currency !== expected.currency ||
            quote.nextCost !== expected.nextCost ||
            quote.maxCost !== expected.maxCost ||
            quote.maxPrice !== expected.maxPrice ||
            quote.amount !== expected.amount
          )
            throw failure(409, "character_upgrade_quote_changed");
          entry.characterBatch.start({
            stat: args.stat,
            amount: args.amount,
            quote,
            budget: expected.maxPrice,
            bulk: true,
          });
          break;
        }
        case "character.upgrade": {
          const expected = args.expected;
          const quote = characterUpgradeQuote(
            entry.characterUpgrade.profile,
            args.stat,
            1,
          );
          if (
            !quote ||
            !expected ||
            [
              "stat",
              "base",
              "dailyUsed",
              "dailyRemaining",
              "dailyLimit",
              "resetAt",
              "currency",
              "nextCost",
              "maxCost",
              "maxPrice",
              "amount",
            ].some((key) => quote[key] !== expected[key])
          )
            throw failure(409, "character_upgrade_quote_changed");
          if (quote.balance < quote.nextCost)
            throw failure(409, "character_upgrade_insufficient_funds");
          entry.characterBatch.start({
            stat: args.stat,
            amount: 1,
            quote,
            budget: quote.maxPrice,
          });
          break;
        }
        case "character.refresh": {
          const character = entry.characterUpgrade;
          const profile = await readCharacterProfile(entry, entry.credential);
          const pending = character.pending;
          if (
            pending &&
            !(pending.runId && pending.runId === character.run?.id) &&
            profile.characterStatsUpgrade.resetAtUtc === pending.resetAt &&
            profile.characterStatsUpgrade[pending.stat]?.dailyUsed ===
              pending.dailyUsed + 1 &&
            profile.characterStats[pending.stat]?.base === pending.base + 1 &&
            profile.wallet[pending.currency] === pending.balance - pending.price
          ) {
            character.pending = null;
            character.notice =
              "Игра показывает повышение характеристики на один пункт. Проверьте результат перед следующей операцией.";
          } else {
            character.notice = pending
              ? "Результат предыдущей операции не подтверждён; повторная отправка заблокирована."
              : null;
          }
          break;
        }
        case "raid.friend.inspect": {
          const result = await inspectRaidFriend({ entry, args, fetcher });
          const status =
            entry.raidFriend.pending?.playerId === result.playerId
              ? "uncertain"
              : Object.hasOwn(entry.raidFriendWatch, String(result.playerId)) &&
                  result.status === "none"
                ? "pending"
                : result.status;
          entry.raidFriendStatuses[`id:${result.playerId}`] = status;
          if (result.username)
            entry.raidFriendStatuses[`name:${result.username}`] = status;
          break;
        }
        case "raid.friend.check": {
          entry.raidFriendStatuses = await checkRaidFriends({
            fetcher,
            credential: entry.credential,
            targets: args.targets,
          });
          const watched = { ...entry.raidFriendWatch };
          if (
            entry.raidFriend.status === "pending" &&
            entry.raidFriend.playerId
          )
            watched[entry.raidFriend.playerId] = entry.raidFriend.username;
          for (const [id, username] of Object.entries(watched)) {
            for (const key of [
              `id:${id}`,
              ...(username ? [`name:${username}`] : []),
            ])
              if (["none", "unknown"].includes(entry.raidFriendStatuses[key]))
                entry.raidFriendStatuses[key] = "pending";
          }
          if (entry.raidFriend.pending) {
            entry.raidFriendStatuses[
              `id:${entry.raidFriend.pending.playerId}`
            ] = "uncertain";
            if (entry.raidFriend.username)
              entry.raidFriendStatuses[`name:${entry.raidFriend.username}`] =
                "uncertain";
          }
          break;
        }
        case "raid.friend.request":
          if (
            Object.keys(entry.raidFriendWatch).length +
              (entry.raidFriend.status === "pending" &&
              entry.raidFriend.playerId &&
              !Object.hasOwn(
                entry.raidFriendWatch,
                String(entry.raidFriend.playerId),
              )
                ? 1
                : 0) >=
            100
          )
            throw failure(409, "too_many_friend_requests");
          await requestRaidFriend({
            entry,
            args,
            commandId: input.id,
            fetcher,
            save,
            allowed: () => !closed && !entry.storageFailed,
          });
          if (entry.raidFriend.status === "pending")
            entry.raidFriendWatch[entry.raidFriend.playerId] =
              entry.raidFriend.username;
          if (entry.raidFriend.playerId)
            entry.raidFriendStatuses[`id:${entry.raidFriend.playerId}`] =
              entry.raidFriend.status;
          if (entry.raidFriend.username)
            entry.raidFriendStatuses[`name:${entry.raidFriend.username}`] =
              entry.raidFriend.status;
          break;
        case "raid.friend.refresh":
          await reconcileRaidFriend({ entry, fetcher, save });
          if (entry.raidFriend.playerId)
            entry.raidFriendStatuses[`id:${entry.raidFriend.playerId}`] =
              entry.raidFriend.status;
          if (entry.raidFriend.username)
            entry.raidFriendStatuses[`name:${entry.raidFriend.username}`] =
              entry.raidFriend.status;
          break;
        case "subscription.start": {
          if (!positive(args.bossId))
            throw failure(400, "invalid_subscription");
          let matching = null;
          let boss = null;
          if (positive(args.leaderPlayerId)) {
            await refreshInvitations(entry, true);
            matching = entry.invitations.items.find(
              (item) =>
                item.leaderPlayerId === args.leaderPlayerId &&
                item.bossId === args.bossId &&
                item.available &&
                item.expiresAt > now(),
            );
            if (!matching) throw failure(409, "subscription_leader_unverified");
          } else {
            if (
              typeof args.leaderUsername !== "string" ||
              !/^@?[A-Za-z0-9_]{1,64}$/.test(args.leaderUsername.trim())
            )
              throw failure(400, "invalid_subscription");
            boss = await getBoss(args.bossId);
            if (
              !boss ||
              Number(boss.numericId ?? boss.apiId ?? boss.id) !== args.bossId
            )
              throw failure(404, "unknown_boss");
          }
          if (
            !entry.raidSubscription.start({
              leaderPlayerId: matching?.leaderPlayerId,
              bossId: args.bossId,
              leaderName: matching?.sender ?? args.leaderUsername,
              bossName: matching?.bossName ?? boss?.name,
              leaderUsername: matching?.leaderUsername ?? args.leaderUsername,
            })
          )
            throw failure(409, "subscription_active");
          if (matching)
            entry.raidSubscription.observe(entry.invitations.items, true);
          break;
        }
        case "subscription.stop":
          for (const job of entry.actionQueue.snapshot())
            if (
              job.type === "subscription.start" &&
              [
                "queued",
                "waiting",
                "running",
                "reconciling",
                "paused",
              ].includes(job.status)
            )
              entry.actionQueue.stop(job.id);
          if (entry.raidSubscription.getSnapshot().mode === "subscription")
            entry.raidSubscription.stop();
          break;
        case "inventory.action":
        case "inventory.refresh":
          if (reconciledPurchase) break;
          await inventoryAction({
            entry,
            args,
            commandId: input.id,
            refreshOnly: input.command === "inventory.refresh",
            fetcher,
            save,
            allowed: () => !closed && !entry.storageFailed,
          });
          break;
        case "equipment.weapon":
        case "equipment.refresh":
          await weaponEquipment({
            entry,
            args,
            commandId: input.id,
            refreshOnly: input.command === "equipment.refresh",
            fetcher,
            save,
          });
          break;
        case "raid.start": {
          const startGeneration = entry.autoStartGeneration ?? 0;
          if (
            entry.pausedAuto ||
            entry.raidWorker.getSnapshot().userPaused ||
            entry.businessHelper.run?.status === "paused" ||
            !args.settings ||
            !state.boss ||
            state.battle?.status === "active" ||
            state.pending ||
            state.pendingInvitation ||
            state.purchase ||
            state.purchaseUncertain ||
            state.medicineOpen
          )
            throw failure(409, "raid_start_unavailable");
          configureAutoGoal(entry, args.settings, state);
          const refreshed = await refreshAutoDamageLimit(entry);
          if (startGeneration !== (entry.autoStartGeneration ?? 0)) break;
          if (!refreshed) throw failure(503, "game_unavailable");
          state = entry.controller.getSnapshot();
          if (state.battle?.status === "active")
            throw failure(409, "raid_start_unavailable");
          configureAutoGoal(entry, args.settings, state);
          if (
            !entry.assistant.begin(
              `${state.boss.id}:${entry.goal.getSnapshot()?.startedAt ?? "single"}`,
            )
          )
            throw failure(409, "raid_safety_unconfirmed");
          if (!entry.raidWorker.start(state.boss.id))
            throw failure(409, "raid_start_unavailable");
          break;
        }
        case "raid.pause":
          entry.raidWorker.pause();
          break;
        case "raid.resume":
          if (!entry.raidWorker.resumePaused())
            throw failure(409, "raid_resume_unavailable");
          break;
        case "raid.stop":
          if (entry.raidSubscription.getSnapshot().checkpoint) {
            const phase = entry.raidSubscription.getSnapshot().phase;
            entry.raidSubscription.discardRaidCheckpoint({
              paused: entry.raidWorker.getSnapshot().userPaused,
            });
            if (phase === "suspending") entry.raidWorker.stop();
            else if (!entry.raidWorker.discardSuspended())
              throw failure(409, "raid_action_pending");
          } else if (entry.raidWorker.getSnapshot().userPaused) {
            entry.raidWorker.stop();
            entry.goal.stop({ clearProgress: true });
          } else entry.raidWorker.finishAfterCurrent();
          break;
        case "invitations.refresh":
          await refreshInvitations(entry);
          break;
        case "invitations.accept":
          try {
            await acceptInvitation(entry, args.invitationId);
          } catch (error) {
            entry.invitations.notice = entry.controller.getSnapshot()
              .pendingInvitation
              ? "Результат вступления не подтверждён. Повторного принятия не будет; нажмите «Проверить вступление»."
              : error.message === "active_battle_exists"
                ? "Сначала завершите текущий бой. Другое приглашение сейчас принять нельзя."
                : "Приглашение недоступно или состояние боя не подтверждено. Обновите список.";
            save(entry);
            throw error;
          }
          break;
        case "work.booster.use":
          await entry.workFarm.useBooster(args.workId, args.type);
          break;
        case "work.stop":
          entry.raidSubscription.discardWorkCheckpoint();
          entry.workFarm.stop();
          break;
        case "work.pause":
          entry.workFarm.pause();
          break;
        case "work.resume":
          entry.workFarm.resumePaused();
          break;
        case "work.refresh":
        case "work.plan":
        case "work.start":
          try {
            if (input.command === "work.refresh")
              await entry.workFarm.refresh(args.workId, {
                manual: args.manual === true,
              });
            else if (input.command === "work.plan")
              await entry.workFarm.plan(args);
            else entry.workFarm.start(args);
          } catch (error) {
            entry.workFarm.getSnapshot().notice = error.message;
            save(entry);
            throw failure(409, "work_farm_conflict");
          }
          break;
        case "open": {
          if (!positive(args.bossId)) throw failure(400, "invalid_boss");
          const boss = await getBoss(args.bossId);
          if (!boss) throw failure(404, "unknown_boss");
          await entry.controller.open(boss, {
            refresh:
              !entry.auto.getSnapshot().enabled &&
              !entry.raidWorker.getSnapshot().enabled,
          });
          await entry.controller.refreshMedicineStock();
          break;
        }
        case "refresh":
          await entry.controller.refresh();
          break;
        case "hydrate":
          await entry.controller.hydrateDetails();
          break;
        case "start":
          await entry.controller.start();
          break;
        case "next":
          await entry.controller.startNextBattle();
          break;
        case "attack":
          await entry.controller.attack();
          break;
        case "medicines.open":
          await entry.controller.openMedicines();
          break;
        case "medicines.close":
          entry.controller.closeMedicines();
          break;
        case "healing.configure":
          try {
            entry.assistant.configure(args.settings);
          } catch {
            throw failure(400, "invalid_healing_settings");
          }
          break;
        case "healing.ack":
          // Refresh stock as part of the explicit reconciliation, never replay POST.
          await entry.controller.loadMedicines();
          entry.assistant.acknowledge();
          entry.controller.acknowledgePurchase();
          break;
        case "medicine.use":
          entry.auto.stop();
          await entry.assistant.use(args.type);
          break;
        case "purchase.prepare":
          if (entry.auto.getSnapshot().enabled && !entry.pausedAuto) {
            entry.pausedAuto = {
              checkpoint: entry.auto.exportState(),
              resumeRequested: false,
              purchasePause: true,
            };
            save(entry);
            if (entry.storageFailed)
              throw failure(503, "automation_storage_unavailable");
          }
          entry.auto.stop();
          if (
            entry.raidWorker.getSnapshot().enabled ||
            entry.raidWorker.getSnapshot().userPaused
          )
            entry.raidWorker.stop();
          entry.controller.preparePurchase(
            args.type,
            args.currency,
            args.quantity,
          );
          if (
            entry.pausedAuto?.purchasePause &&
            !entry.controller.getSnapshot().purchase
          )
            entry.pausedAuto.resumeRequested = true;
          break;
        case "purchase.cancel":
          entry.controller.cancelPurchase();
          if (entry.pausedAuto?.purchasePause) {
            entry.pausedAuto.resumeRequested = true;
            entry.pausedAuto.nextAttemptAt = 0;
          }
          break;
        case "purchase.buy":
          await entry.assistant.buy(entry.controller.getSnapshot().purchase);
          break;
        case "purchase.ack":
          entry.controller.acknowledgePurchase();
          break;
        case "auto.start": {
          if (entry.pausedAuto)
            throw failure(409, "automation_paused_resume_or_stop");
          const startGeneration = entry.autoStartGeneration ?? 0;
          configureAutoGoal(entry, args.settings, state);
          const refreshed = await refreshAutoDamageLimit(entry);
          if (startGeneration !== (entry.autoStartGeneration ?? 0)) break;
          if (!refreshed) throw failure(503, "game_unavailable");
          state = entry.controller.getSnapshot();
          // A completed invitation fight does not restrict a new solo intent.
          // Keep uncertain invitation/purchase checkpoints intact; any stale
          // read still goes through the series' live recovery before a POST.
          if (state.invitationOnly && state.battle?.status !== "active") {
            if (
              !entry.controller.allowSoloContinuation({ allowRecovery: true })
            )
              throw failure(409, "automation_start_unavailable");
          }
          if (
            !entry.goal.getSnapshot() ||
            entry.goal.getSnapshot().status === "active"
          ) {
            const started = entry.auto.start();
            if (started) entry.pausedAuto = null;
            if (args.settings != null && !started)
              throw failure(409, "automation_start_unavailable");
          }
          break;
        }
        case "auto.pause":
          if (entry.pausedAuto?.purchasePause) {
            entry.pausedAuto.purchasePause = false;
            entry.pausedAuto.resumeRequested = false;
          }
          if (entry.auto.getSnapshot().enabled && !entry.pausedAuto) {
            entry.pausedAuto = {
              checkpoint: entry.auto.exportState(),
              resumeRequested: false,
            };
            save(entry);
            if (entry.storageFailed)
              throw failure(503, "automation_storage_unavailable");
            entry.auto.stop();
          }
          break;
        case "auto.resume":
          if (entry.auto.getSnapshot().stopAfterBattle) {
            if (state.battle?.status !== "active")
              throw failure(409, "auto_resume_unavailable");
            entry.goal.resumeSeries();
            entry.auto.resumeSeries();
          } else if (entry.pausedAuto) {
            entry.pausedAuto.resumeRequested = true;
            entry.pausedAuto.nextAttemptAt = 0;
            save(entry);
          }
          break;
        case "auto.stop":
          if (entry.raidSubscription.getSnapshot().checkpoint) {
            const checkpoint = entry.raidSubscription.getSnapshot().checkpoint;
            if (
              !entry.raidSubscription.discardAutoCheckpoint({
                paused: Boolean(entry.pausedAuto),
              }) &&
              !checkpoint.autoCancelled
            )
              throw failure(409, "subscription_controls_automation");
            if (entry.pausedAuto) {
              entry.pausedAuto = null;
              save(entry);
            }
            break;
          }
          if (
            entry.auto.getSnapshot().enabled &&
            !entry.raidWorker.getSnapshot().enabled &&
            !entry.raidWorker.getSnapshot().userPaused &&
            !entry.collector.running() &&
            state.battle?.status === "active" &&
            entry.auto.finishCurrent({ stopAfterBattle: true })
          ) {
            entry.assistant.invalidatePendingWork();
            entry.goal.finishCurrentBattle();
            break;
          }
          entry.pausedAuto = null;
          if (
            entry.raidWorker.getSnapshot().enabled ||
            entry.raidWorker.getSnapshot().userPaused
          )
            entry.raidWorker.stop();
          entry.collector.stop();
          entry.auto.stop();
          entry.goal.stop({ clearProgress: true });
          break;
        case "goal.configure": {
          if (!state.boss || args.bossId !== state.boss.id)
            throw failure(400, "goal_boss_mismatch");
          entry.pausedAuto = null;
          entry.auto.stop();
          entry.goal.configure(resolveBossGoal(args, state.boss));
          break;
        }
        case "goal.stop":
          if (entry.raidSubscription.getSnapshot().checkpoint) {
            const checkpoint = entry.raidSubscription.getSnapshot().checkpoint;
            if (
              !checkpoint.goalCancelled &&
              (entry.businessHelper.run?.status === "paused" ||
                entry.raidWorker.getSnapshot().userPaused ||
                entry.pausedAuto)
            )
              throw failure(409, "subscription_controls_automation");
            if (
              !entry.raidSubscription.discardGoalCheckpoint() &&
              !checkpoint.goalCancelled
            )
              throw failure(409, "subscription_controls_automation");
            break;
          }
          entry.pausedAuto = null;
          if (
            entry.raidWorker.getSnapshot().enabled ||
            entry.raidWorker.getSnapshot().userPaused
          )
            entry.raidWorker.stop();
          entry.collector.stop();
          entry.auto.stop();
          entry.goal.stop();
          break;
        case "goal.reset":
          entry.pausedAuto = null;
          entry.auto.stop();
          entry.goal.reset();
          break;
        case "pvp.refresh":
          await refreshPvp(entry);
          break;
        case "business.run.pause":
          entry.collector.pause();
          break;
        case "business.run.resume":
          entry.collector.resumePaused();
          break;
        case "business.run.stop":
          if (entry.raidSubscription.getSnapshot().checkpoint) {
            const phase = entry.raidSubscription.getSnapshot().phase;
            entry.raidSubscription.discardBusinessCheckpoint({
              ownsGoal: Boolean(entry.businessHelper.run?.ownsGoal),
              paused: entry.businessHelper.run?.status === "paused",
            });
            if (phase === "suspending") entry.collector.stop();
            else if (!entry.collector.discardSuspended())
              throw failure(409, "business_action_pending");
          } else entry.collector.stop();
          break;
        case "business.run.start":
          try {
            entry.collector.start(args);
          } catch (error) {
            entry.businessHelper.notice =
              BUSINESS_NOTICES[error.message] ||
              "Не удалось запустить сбор. Проверьте план и лимиты.";
            save(entry);
            throw failure(409, "business_assistant_conflict");
          }
          break;
        case "business.select":
        case "business.save":
        case "business.refresh":
        case "business.goal": {
          const helper = entry.businessHelper;
          const catalogue = getBusinessCatalogue();
          try {
            if (input.command === "business.select")
              selectBusiness(helper, catalogue, args.businessId);
            if (input.command === "business.save")
              saveBusiness(helper, catalogue, args);
            if (input.command === "business.refresh") {
              selectBusiness(helper, catalogue, args.businessId);
              await refreshBusiness(helper, catalogue, args.businessId, {
                get: (path) => gameJson(entry.credential, path),
                now,
              });
            }
            if (input.command === "business.goal") {
              if (state.pending) throw new Error("business_action_pending");
              if (
                state.battle?.status === "active" &&
                state.boss?.id !== args.bossId
              )
                throw new Error("business_active_battle");
              if (
                entry.goal.getSnapshot()?.status === "active" &&
                args.replaceExisting !== true
              )
                throw new Error("business_goal_exists");
              entry.auto.stop();
              const complete = await refreshBusiness(
                helper,
                catalogue,
                args.businessId,
                { get: (path) => gameJson(entry.credential, path), now },
              );
              if (!complete) throw new Error("business_refresh_failed");
              const plan = businessPlan(helper, catalogue, args.businessId);
              const actualLevel =
                helper.resources.details[args.businessId]?.level;
              if (
                plan.currentLevelSource === "manual" &&
                actualLevel != null &&
                actualLevel !== plan.currentLevel
              )
                throw new Error("business_manual_level_changed");
              const material = plan.materials.find(
                (item) => item.entityId === args.itemId,
              );
              if (!material || material.missingAmount == null)
                throw new Error("business_missing_unknown");
              if (material.missingAmount === 0)
                throw new Error("business_nothing_missing");
              if (material.missingAmount !== args.expectedMissing)
                throw new Error("business_stock_changed");
              if (!material.bosses.some((boss) => boss.id === args.bossId))
                throw new Error("business_boss_unknown");
              const boss = await getBoss(args.bossId);
              if (!boss) throw new Error("business_boss_unknown");
              await entry.controller.open(boss);
              const selected = entry.controller.getSnapshot();
              if (
                selected.boss?.id !== args.bossId ||
                selected.pending ||
                selected.needsRefresh
              )
                throw new Error("business_action_pending");
              entry.goal.configure(
                resolveBossGoal(
                  {
                    bossId: args.bossId,
                    kind: "business_items",
                    itemKey: `activity_item:${args.itemId}`,
                    targetCount: material.missingAmount,
                    maxAttempts: plan.config.maxAttempts,
                  },
                  selected.boss,
                ),
              );
              helper.notice = `Цель создана: ${material.name} · ${material.missingAmount} шт.`;
            }
          } catch (error) {
            helper.notice =
              BUSINESS_NOTICES[error.message] ||
              "Не удалось подготовить план бизнеса. Обновите данные и повторите действие.";
            save(entry);
            throw failure(409, "business_assistant_conflict");
          }
          break;
        }
        case "favorites.set": {
          if (
            !Array.isArray(args.bossIds) ||
            args.bossIds.length > 200 ||
            !args.bossIds.every(positive)
          )
            throw failure(400, "invalid_favorites");
          entry.preferences = {
            ...entry.preferences,
            favoriteBossIds: [...new Set(args.bossIds)],
          };
          break;
        }
      }
      save(entry);
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      return snapshot(entry);
    } finally {
      entry.busy = wasBusy;
    }
  }
  async function command(entry, input) {
    try {
      return await commandInner(entry, input);
    } catch (error) {
      if (input?.command?.startsWith("raid.friend."))
        logFriendError(input.command, error);
      else if (
        input?.command === "queue.enqueue" &&
        input.args?.type === "friend.request"
      )
        logFriendError("friend.request.enqueue", error);
      throw error;
    }
  }
  return {
    identify,
    launch,
    snapshot,
    command,
    async refreshFriends(entry, authorization) {
      if (
        entry.credential !== authorization ||
        accountHealth(authorization)?.status === "credentials_invalid"
      )
        throw failure(401, "game_session_required");
      entry.friendSnapshot.enabled = true;
      if (!entry.friendSnapshot.failures) entry.friendSnapshot.nextAt = 0;
      save(entry);
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      await refreshFriendSnapshot(entry);
      return { scheduled: true };
    },
    friends(entry, authorization) {
      if (
        entry.credential !== authorization ||
        accountHealth(authorization)?.status === "credentials_invalid"
      )
        throw failure(401, "game_session_required");
      if (!entry.friendSnapshot.enabled) {
        entry.friendSnapshot.enabled = true;
        entry.friendSnapshot.nextAt = 0;
        save(entry);
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
      }
      const stale =
        entry.friendSnapshot.failures > 0 ||
        (Number.isFinite(entry.friendSnapshot.updatedAt) &&
          now() - entry.friendSnapshot.updatedAt >= 300000);
      if (stale && now() >= (entry.friendStaleDiagnosticAt ?? 0)) {
        entry.friendStaleDiagnosticAt = now() + 300000;
        const reason =
          entry.friendSnapshot.failures > 0
            ? "refresh_failed_or_in_progress"
            : entry.friendSnapshotRefreshing
              ? "refreshing"
              : entry.storageFailed
                ? "storage_unavailable"
                : !entry.credential
                  ? "missing_credential"
                  : entry.busy || entry.inventoryBusy
                    ? "account_busy"
                    : entry.actionQueue.hasDue() ||
                        queuedFriendReadPending(entry)
                      ? "queue_pending"
                      : backgroundReadDeferred(entry)
                        ? "background_deferred"
                        : entry.characterBatch.running() ||
                            !entry.collector.idleForPriority() ||
                            entry.controller.getSnapshot().pending
                          ? "automation_busy"
                          : now() < (entry.friendSnapshot.nextAt ?? 0)
                            ? "retry_scheduled"
                            : "awaiting_refresh";
        console.warn("madhouse-friend-stale", JSON.stringify({ reason }));
      }
      return {
        items: entry.friendSnapshot.items,
        updatedAt: entry.friendSnapshot.updatedAt,
        stale,
        refreshing: entry.friendSnapshotRefreshing,
      };
    },
    async boot() {
      ensureLease();
      booting = true;
      heartbeat = setInterval(() => {
        try {
          ensureLease();
        } catch {
          for (const entry of actors.values()) {
            entry.storageFailed = true;
            entry.auto.stop();
            entry.workFarm.stop();
          }
          return;
        }
        for (const entry of actors.values()) {
          if (!booting) tryResumePausedAuto(entry);
          const pendingInvite = entry.assistant.queuedState().pending;
          if (
            !booting &&
            pendingInvite?.kind === "invite" &&
            !pendingInvite.queueId &&
            !entry.busy &&
            !entry.inventoryBusy &&
            !entry.storageFailed &&
            entry.credential &&
            accountHealth(entry.credential)?.status !== "credentials_invalid" &&
            ["won", "lost", "expired", "surrendered"].includes(
              entry.controller.getSnapshot().battle?.status,
            ) &&
            entry.collector.idleForPriority() &&
            !characterPriorityActive(entry) &&
            now() >= (entry.inviteRecoveryAt ?? 0)
          ) {
            entry.inviteRecoveryAt = now() + 30000;
            entry.busy = true;
            entry.inventoryBusy = true;
            void entry.assistant
              .recover()
              .catch(() => {})
              .finally(() => {
                entry.inventoryBusy = false;
                entry.busy = false;
              });
          }
          if (
            !booting &&
            entry.actionQueue.hasDue() &&
            !entry.busy &&
            !entry.inventoryBusy
          ) {
            entry.busy = true;
            entry.inventoryBusy = true;
            void entry.actionQueue
              .tick()
              .catch(() => {})
              .finally(() => {
                entry.inventoryBusy = false;
                entry.busy = false;
              });
          }
          if (
            !entry.busy &&
            !entry.inventoryBusy &&
            entry.credential &&
            !entry.storageFailed &&
            entry.friendResponse.pending &&
            now() >= entry.friendResponseNextCheck
          ) {
            const pending = entry.friendResponse.pending;
            entry.friendResponseNextCheck = now() + 15000;
            entry.busy = true;
            void queuedFriendResponseAdapter({ entry, fetcher, save })
              .reconcile(pending)
              .then((result) => {
                if (
                  result.status === "completed" &&
                  entry.friendResponse.pending?.id === pending.id
                ) {
                  entry.friendResponse.pending = null;
                  save(entry);
                }
              })
              .catch(() => {})
              .finally(() => {
                entry.busy = false;
              });
          }
          void refreshPendingFriendRemoval(entry);
          void refreshFriendSnapshot(entry);
          discoverInvitations(entry);
          void refreshPendingFriend(entry);
          void entry.raidSubscription.tick().catch(() => {});
          if (
            !entry.busy &&
            !entry.inventoryBusy &&
            !characterPriorityActive(entry) &&
            entry.workFarm.canSuspend() &&
            !entry.workFarm.getSnapshot().manualPending &&
            !entry.storageFailed &&
            entry.credential &&
            now() >= entry.buddyHelpNextAt &&
            (entry.buddyHelp.pending || entry.buddyHelp.stashPending)
          ) {
            entry.buddyHelpNextAt = now() + 30000;
            entry.busy = true;
            // Prevent work/inventory resource mutations between the fresh reserve
            // read and the buddy gift; existing work must be at a safe boundary.
            entry.inventoryBusy = true;
            const chooseStash =
              Boolean(entry.buddyHelp.stashPending) ||
              (!entry.buddyHelp.pending &&
                entry.buddyHelp.stashEnabled &&
                (!entry.buddyHelp.boostersEnabled ||
                  entry.buddyHelp.turn === "stash"));
            entry.buddyHelp.turn = chooseStash ? "booster" : "stash";
            // Existing gift checkpoints may be reconciled, but Buddy no longer sends gifts.
            const allowed = () => false;
            const run = chooseStash ? tickBuddyStash : tickBuddyBooster;
            void run({ entry, fetcher, save, now, allowed })
              .catch(() => {
                if (!closed && !entry.storageFailed) {
                  entry.buddyHelp.notice =
                    entry.buddyHelp.pending || entry.buddyHelp.stashPending
                      ? "Результат помощи не подтверждён; повтор заблокирован."
                      : "Не удалось проверить просьбы Buddy. Повторим проверку позже.";
                  save(entry);
                }
              })
              .finally(() => {
                entry.inventoryBusy = false;
                entry.busy = false;
              });
          }
          if (
            !booting &&
            entry.floorRunner.getSnapshot().status === "running" &&
            !entry.raidSubscription.getSnapshot().checkpoint &&
            now() >= (entry.floorRunner.getSnapshot().nextCheckAt ?? 0) &&
            !entry.busy &&
            !entry.inventoryBusy &&
            !entry.storageFailed &&
            !characterPriorityActive(entry)
          ) {
            entry.busy = true;
            void entry.floorRunner
              .tick()
              .catch(() => {})
              .finally(() => {
                entry.busy = false;
              });
          }
          if (now() < (entry.workerRetryAt ?? 0)) continue;
          try {
            updateGoal(entry);
            entry.collector.tick();
            entry.workFarm.tick();
            void entry.raidWorker.tick().catch(() => {
              entry.workerRetryAt = now() + 30000;
            });
            reconcileFinishedBattle(entry);
            entry.workerRetryAt = null;
          } catch {
            // An account-specific reader/state error must not stop other
            // accounts or overwrite durable execution intent with a stop.
            entry.workerRetryAt = now() + 30000;
          }
        }
      }, 1000);
      heartbeat.unref?.();
      // Restore enabled workers without waiting for a browser to reconnect.
      for (const { playerId, value } of store.list()) {
        // Discovery is server-owned and continues even when no browser is open.
        if (value?.credential) await actor(playerId);
        if (
          value?.credential &&
          value?.floorRunner?.status === "running" &&
          value.floorRunner.phase === "launching"
        ) {
          const entry = await actor(playerId);
          entry.floorActions.stopOwned(value.floorRunner.target);
          save(entry);
          continue;
        }
        if (value?.raidSubscription?.checkpoint) continue;
        if (
          !value?.raid?.enabled &&
          !value?.auto?.enabled &&
          value?.businessHelper?.run?.status !== "running" &&
          value?.workFarm?.run?.status !== "running"
        )
          continue;
        const entry = await actor(playerId);
        if (value?.workFarm?.run?.status === "running") {
          entry.workFarm.resume();
          save(entry);
          if (
            !value?.raid?.enabled &&
            !value?.auto?.enabled &&
            value?.businessHelper?.run?.status !== "running"
          )
            continue;
        }
        if (
          (value?.pausedAuto ||
            value?.raid?.userPaused ||
            value?.businessHelper?.run?.status === "paused") &&
          value?.businessHelper?.run?.status !== "running"
        )
          continue;
        if (value?.raid?.enabled) {
          // A pending accept is never replayed. Only confirmed joined fights resume strikes.
          if (
            entry.controller.getSnapshot().boss &&
            !value.battle?.pendingInvitation &&
            !value.battle?.pending &&
            !value.battle?.needsRefresh
          )
            await entry.controller.refresh();
          if (!entry.controller.getSnapshot().needsRefresh)
            await entry.controller.refreshDamageLimit();
          entry.raidWorker.resume();
          if (
            entry.raidWorker.getSnapshot().enabled &&
            entry.controller.getSnapshot().invitationOnly &&
            entry.controller.getSnapshot().battle?.status === "active"
          ) {
            entry.auto.start({
              checkpoint: value.raid.stopAfterBattle
                ? {
                    ...value.auto,
                    singleBattle: true,
                    singleBattleId: entry.controller.getSnapshot().battle.id,
                  }
                : value.auto,
              resumeAt: value.auto?.nextAttackAt,
            });
          }
          save(entry);
          continue;
        }
        const prior = value.battle;
        if (
          !entry.credential ||
          value.auto?.phase === "starting" ||
          prior?.pending ||
          prior?.needsRefresh ||
          prior?.purchaseUncertain
        ) {
          if (entry.collector.running())
            entry.collector.resume(value.auto, true);
          else if (value.auto?.enabled)
            entry.auto.start({
              checkpoint: value.auto,
              resumeAt: value.auto?.nextAttackAt,
            });
          save(entry);
          continue;
        }
        if (entry.controller.getSnapshot().boss)
          await entry.controller.refresh();
        if (!entry.controller.getSnapshot().needsRefresh)
          await entry.controller.refreshDamageLimit();
        if (entry.collector.running()) {
          entry.collector.resume(
            value.auto,
            Boolean(entry.controller.getSnapshot().needsRefresh),
          );
          save(entry);
          continue;
        }
        if (
          value.auto?.enabled &&
          (!entry.goal.getSnapshot() ||
            entry.goal.getSnapshot().status === "active")
        )
          entry.auto.start({
            resumeAt: value.auto.nextAttackAt,
            checkpoint: value.auto,
          });
        save(entry);
      }
      booting = false;
    },
    close() {
      closed = true;
      for (const entry of actors.values()) {
        entry.floorRunner.dispose();
        for (const unsub of entry.unsubscribers) unsub();
        entry.workFarm.dispose();
        entry.characterBatch.dispose();
        entry.collector.dispose();
        entry.auto.dispose();
        entry.goal.dispose();
        entry.controller.reset();
      }
      if (heartbeat) clearInterval(heartbeat);
      store.releaseLease(owner);
      actors.clear();
      identities.clear();
    },
  };
}
