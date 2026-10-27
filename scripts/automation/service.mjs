import { recoverBrokenWeapon } from "./weapon-recovery.mjs";
import { inventoryAction } from "./inventory-actions.mjs";
import { weaponEquipment } from "./weapon-equipment.mjs";
import { createBattleAssistant } from "./battle-assistant.mjs";
import { createRaidWaiter } from "./raid-waiter.mjs";
import { createAccountQueue } from "./account-queue.mjs";
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
import { createBossBattleController } from "../../src/features/bosses/BossBattle/boss-battle-controller.js";
import {
  resolveBossGoal,
  restoredShopDropGoal,
} from "../../src/features/bosses/BossBattle/boss-goal-options.js";
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
const missingGameTransport = async () => {
  throw failure(503, "game_transport_not_configured");
};
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
const characterIntentWhileAttackPending = (command, pending) =>
  pending?.kind === "attack" &&
  ["character.upgrade", "character.start", "character.startAll"].includes(
    command,
  );
const INVITATION_DISCOVERY_INTERVAL_MS = 30000;
const safeCommands = new Set([
  "friends.reconcile",
  "floor.stop",
  "character.refresh",
  "character.stop",
  "raid.friend.check",
  "raid.friend.inspect",
  "raid.friend.refresh",
  "inventory.refresh",
  "raid.stop",
  "invitations.refresh",
  "subscription.stop",
  "business.run.stop",
  "work.stop",
  "work.refresh",
  "auto.stop",
  "goal.stop",
  "pvp.refresh",
  "business.select",
  "business.refresh",
]);
const commandControlCommands = new Set([
  "raid.stop",
  "auto.stop",
  "goal.stop",
  "business.run.stop",
  "work.stop",
  "floor.stop",
  "character.stop",
  "subscription.stop",
]);
const readOnlyWhilePending = new Set([
  "refresh",
  "hydrate",
  "invitations.refresh",
  "inventory.refresh",
  "equipment.refresh",
  "pvp.refresh",
  "business.refresh",
]);
const restoreReconciliationCommands = new Set([
  "buddy.resolve",
  "character.refresh",
  "friends.reconcile",
  "raid.friend.refresh",
]);
const COMMAND_ADMISSION_TTL_MS = 5 * 60 * 1000;
const MAX_COMMAND_ADMISSIONS = 128;
const commands = new Set([
  "buddy.set",
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
  "invitations.refresh",
  "invitations.accept",
  "subscription.start",
  "subscription.stop",
  "work.refresh",
  "work.plan",
  "work.start",
  "work.booster.use",
  "work.stop",
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
]);

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("automation_command_arguments_not_json");
}

function commandArgumentsDigest(args) {
  let normalized;
  try {
    normalized = canonicalJson(args);
  } catch {
    throw failure(400, "invalid_command_arguments");
  }
  if (Buffer.byteLength(normalized) > 16_384)
    throw failure(413, "command_arguments_too_large");
  return createHash("sha256").update(normalized).digest("hex");
}

// One wiki process owns all actors and timers. Browser connections are observers.
export function createAutomationService({
  store,
  getBoss,
  getBusinessCatalogue = () => ({
    businesses: [],
    businessUpgrades: [],
    bosses: [],
  }),
  fetcher = missingGameTransport,
  identifyPlayer,
  accountHealth = () => null,
  snapshotFetch = fetcher,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
  commandAdmissionTtlMs = COMMAND_ADMISSION_TTL_MS,
}) {
  if (!Number.isSafeInteger(commandAdmissionTtlMs) || commandAdmissionTtlMs < 1)
    throw new TypeError("automation_command_admission_ttl_invalid");
  const actors = new Map();
  const loading = new Map();
  const identities = new Map();
  fetcher = createAccountQueue(fetcher, {
    accountKey: (authorization) =>
      [...actors.values()].find((entry) => entry.credential === authorization)
        ?.playerId ??
      identities.get(createHash("sha256").update(authorization).digest("hex"))
        ?.playerId ??
      authorization,
    now,
  });
  let closed = false;
  let booting = false;
  let disposed = false;
  let heartbeat = null;
  const owner = randomUUID();
  function ensureLease({ allowClosed = false } = {}) {
    if ((closed && !allowClosed) || !store.acquireLease(owner, now(), 15000))
      throw failure(503, "automation_worker_unavailable");
  }
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
    if (!response.ok)
      throw failure(response.status, "game_session_unavailable");
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
    if (!response.ok || response.headers.get("X-Madhouse-Snapshot") === "stale")
      throw failure(503, "character_profile_unavailable");
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
      assistant: entry.assistant.exportState(),
      pvp: entry.pvp,
      equipment: entry.equipment,
      buddyHelp: entry.buddyHelp,
      friendRemoval: entry.friendRemoval,
      raidFriend: entry.raidFriend,
      raidFriendStatuses: entry.raidFriendStatuses,
      raidFriendWatch: entry.raidFriendWatch,
      preferences: entry.preferences,
      invitations: entry.invitations,
      raidObservations: observeRaids(entry.raidObservations, [], now()),
      raid: entry.raidWorker.getSnapshot(),
      raidSubscription: entry.raidSubscription?.getSnapshot() ?? null,
      receipts: entry.receipts,
      pendingReceiptId: entry.pendingReceiptId,
      commandAdmissions: entry.commandAdmissions,
      updatedAt: now(),
    };
  }
  function save(entry, restoreCheck = null) {
    if (entry.restoring || disposed) return;
    const expectedVersion = entry.version;
    try {
      ensureLease({ allowClosed: true });
      const pendingAttack = entry.assistant?.exportState()?.pending;
      if (
        pendingAttack?.kind === "attack" &&
        typeof entry.activeAttackCommandId === "string"
      )
        entry.pendingReceiptId = entry.activeAttackCommandId;
      else if (pendingAttack?.kind !== "attack" && entry.pendingReceiptId) {
        entry.receipts = [
          ...entry.receipts
            .filter((id) => id !== entry.pendingReceiptId)
            .slice(-127),
          entry.pendingReceiptId,
        ];
        entry.pendingReceiptId = null;
      }
      if (entry.commandAdmissionCompletionId) {
        const admission = entry.commandAdmissions.find(
          ({ id }) => id === entry.commandAdmissionCompletionId,
        );
        if (admission?.state === "consumed") {
          admission.state = "completed";
          admission.result = {
            id: admission.id,
            command: admission.command,
            completedAt: now(),
            version: entry.version + 1,
          };
        }
      }
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 ||
        expectedVersion >= Number.MAX_SAFE_INTEGER ||
        typeof store.writeIfVersion !== "function"
      )
        throw new Error("automation_storage_version_unavailable");
      entry.version = expectedVersion + 1;
      if (
        !store.writeIfVersion(
          entry.playerId,
          expectedVersion,
          persisted(entry),
          restoreCheck,
        )
      )
        throw new Error("automation_state_version_conflict");
    } catch {
      // No game call is allowed after a durability failure.
      entry.version = expectedVersion;
      entry.storageFailed = true;
    }
  }
  async function submitCharacterPoint(entry, expected, allowed, onConfirmed) {
    const credential = entry.credential;
    const permitted = () =>
      allowed() &&
      !closed &&
      !entry.storageFailed &&
      !store.isRestoreRequired(entry.playerId) &&
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

  function boundAuthState(playerId) {
    if (
      typeof store.readGameAccountOwner !== "function" ||
      typeof store.readGameAuthRecovery !== "function"
    )
      return null;
    const binding = store.readGameAccountOwner(String(playerId));
    if (!binding) return null;
    return {
      binding,
      recovery: store.readGameAuthRecovery(binding.ownerId),
      bootstrap: store.readGameAuthBootstrap?.(binding.ownerId) || null,
      route: store.readRoutePolicy(String(playerId)),
    };
  }
  function canUseAccountSession(playerId) {
    const bound = boundAuthState(playerId);
    if (!bound) return true;
    if (["logout_pending", "logged_out"].includes(bound.recovery?.state))
      return false;
    if (bound.bootstrap && bound.bootstrap.state !== "ready") return false;
    return (
      bound.route?.policy !== "bridge_required" ||
      bound.recovery?.state === "ready"
    );
  }
  function assertIdentityAllowed(playerId, authorization, entry) {
    const bound = boundAuthState(playerId);
    if (!bound) return;
    if (["logout_pending", "logged_out"].includes(bound.recovery?.state))
      throw failure(401, "game_session_logged_out");
    if (bound.bootstrap && bound.bootstrap.state !== "ready")
      throw failure(401, "game_session_required");
    if (
      bound.route?.policy === "bridge_required" &&
      (bound.recovery?.state !== "ready" || entry?.credential !== authorization)
    )
      throw failure(401, "game_session_required");
  }
  function admitGameMutation({ operation, route, request }) {
    try {
      ensureLease();
      const accountId = request?.context?.accountId;
      const attempt = request?.context?.automationAttempt;
      if (
        route?.policy !== "bridge_required" ||
        typeof accountId !== "string" ||
        attempt?.playerId !== accountId ||
        attempt?.kind !== "boss.attack" ||
        request.method !== "POST" ||
        operation?.operationClass !== "mutation"
      )
        return null;
      const match = /^\/api\/bosses\/battles\/([A-Za-z0-9_-]+)\/attack$/u.exec(
        request.path,
      );
      if (!match) return null;
      let body;
      try {
        body = JSON.parse(request.body);
      } catch {
        return null;
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        body.operationId !== attempt.operationId ||
        match[1] !== attempt.battleId
      )
        return null;
      const entry = actors.get(accountId);
      const pending = entry?.assistant?.exportState()?.pending;
      const authorization = request.headers.get("authorization");
      const binding = store.readGameAccountOwner(accountId);
      const recovery = binding
        ? store.readGameAuthRecovery(binding.ownerId)
        : null;
      const currentRoute = store.readRoutePolicy(accountId);
      const state = entry?.controller?.getSnapshot();
      if (
        !entry ||
        entry.storageFailed ||
        !entry.credential ||
        authorization !== entry.credential ||
        !canAct(entry) ||
        !binding ||
        binding.playerId !== accountId ||
        recovery?.state !== "ready" ||
        route.routeEpoch !== currentRoute.routeEpoch ||
        route.activeDeviceId !== currentRoute.activeDeviceId ||
        currentRoute.policy !== "bridge_required" ||
        pending?.kind !== "attack" ||
        attempt.commandId !== pending.commandId ||
        attempt.attemptId !== pending.attemptId ||
        pending.operationId !== body.operationId ||
        pending.battleId !== match[1] ||
        state?.pending !== "attack" ||
        state.battle?.id !== match[1]
      )
        return null;
      const argumentsDigest = createHash("sha256")
        .update(
          JSON.stringify({
            method: "POST",
            path: request.path,
            body: { operationId: body.operationId },
          }),
        )
        .digest("hex");
      const admission = {
        schemaVersion: 1,
        action: "boss.attack",
        playerId: accountId,
        ownerId: binding.ownerId,
        commandId: pending.commandId,
        attemptId: pending.attemptId,
        operationId: body.operationId,
        battleId: match[1],
        argumentsDigest,
        workerEpoch: owner,
        actorVersion: entry.version + 1,
        authGeneration: recovery.authGeneration,
        consentGeneration: recovery.consentGeneration,
        credentialVersion: recovery.credentialVersion,
        routeEpoch: route.routeEpoch,
        deviceId: route.activeDeviceId,
        admittedAt: now(),
        connectionId: null,
        connectionEstablishedAt: null,
      };
      if (!entry.assistant.bindAdmission(admission) || entry.storageFailed)
        return null;
      return Object.freeze(admission);
    } catch {
      return null;
    }
  }
  function bindGameMutationConnection({ admission, connectionId, route } = {}) {
    try {
      ensureLease();
      if (
        !admission ||
        admission.action !== "boss.attack" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          connectionId || "",
        )
      )
        return false;
      const entry = actors.get(admission.playerId);
      const pending = entry?.assistant?.exportState()?.pending;
      const savedAdmission = pending?.admission;
      const binding = store.readGameAccountOwner(admission.playerId);
      const recovery = binding
        ? store.readGameAuthRecovery(binding.ownerId)
        : null;
      const currentRoute = store.readRoutePolicy(admission.playerId);
      if (
        !entry ||
        entry.storageFailed ||
        entry.credential == null ||
        binding?.ownerId !== admission.ownerId ||
        binding.playerId !== admission.playerId ||
        recovery?.state !== "ready" ||
        recovery.authGeneration !== admission.authGeneration ||
        recovery.consentGeneration !== admission.consentGeneration ||
        recovery.credentialVersion !== admission.credentialVersion ||
        route?.policy !== "bridge_required" ||
        currentRoute.policy !== "bridge_required" ||
        route.routeEpoch !== admission.routeEpoch ||
        route.activeDeviceId !== admission.deviceId ||
        currentRoute.routeEpoch !== admission.routeEpoch ||
        currentRoute.activeDeviceId !== admission.deviceId ||
        pending?.kind !== "attack" ||
        pending.commandId !== admission.commandId ||
        pending.attemptId !== admission.attemptId ||
        pending.operationId !== admission.operationId ||
        pending.battleId !== admission.battleId ||
        savedAdmission?.commandId !== admission.commandId ||
        savedAdmission?.attemptId !== admission.attemptId
      )
        return false;
      if (savedAdmission.connectionId != null)
        return savedAdmission.connectionId === connectionId;
      const {
        connectionId: _ignoredConnectionId,
        connectionEstablishedAt: _ignoredConnectionTime,
        ...requestedBase
      } = admission;
      const {
        connectionId: _ignoredSavedConnectionId,
        connectionEstablishedAt: _ignoredSavedConnectionTime,
        ...savedBase
      } = savedAdmission;
      if (JSON.stringify(requestedBase) !== JSON.stringify(savedBase))
        return false;
      return (
        entry.assistant.bindAdmission({
          ...savedAdmission,
          connectionId,
          connectionEstablishedAt: now(),
        }) && !entry.storageFailed
      );
    } catch {
      return false;
    }
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
      entry.characterUpgrade?.pending || entry.characterBatch?.running(),
    );
  }
  function canAct(entry) {
    if (!canUseAccountSession(entry.playerId)) return false;
    if (characterPriorityActive(entry)) return false;
    if (entry.workFarm?.getSnapshot().manualPending) return false;
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
  async function refreshAutoDamageLimit(entry) {
    const generation = entry.autoStartGeneration ?? 0;
    await entry.controller.refresh({ discover: true });
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
    return {
      raid: entry.raidWorker.getSnapshot(),
      subscription: (() => {
        const subscription = entry.raidSubscription.getSnapshot();
        if (subscription.mode === "buddy")
          return { enabled: false, phase: "idle", hasSuspendedGoal: false };
        const { checkpoint, ...publicState } = subscription;
        return { ...publicState, hasSuspendedGoal: Boolean(checkpoint) };
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
          log: value.log ?? [],
        };
      })(),
      detectedRaids: detectedRaids(
        entry.raidObservations,
        entry.invitations.items,
        now(),
      ),
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
      raidFriend: saved?.raidFriend ?? { pending: null, status: null },
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
      pendingReceiptId: saved?.pendingReceiptId ?? null,
      commandAdmissions: Array.isArray(saved?.commandAdmissions)
        ? saved.commandAdmissions
            .filter(
              (admission) =>
                admission &&
                typeof admission.id === "string" &&
                /^[A-Za-z0-9_-]{8,80}$/u.test(admission.id) &&
                Number.isSafeInteger(admission.expiresAt) &&
                Number.isSafeInteger(admission.intentVersion) &&
                Number.isSafeInteger(admission.routeEpoch) &&
                typeof admission.command === "string" &&
                /^[0-9a-f]{64}$/u.test(admission.argumentsDigest) &&
                ["issued", "consumed", "completed"].includes(admission.state),
            )
            .slice(-MAX_COMMAND_ADMISSIONS)
        : [],
      commandAdmissionCompletionId: null,
      activeAttackCommandId: null,
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
        let automationAttempt;
        if (init.method === "POST") {
          const path = new URL(url).pathname;
          const match =
            /^\/api\/bosses\/battles\/([A-Za-z0-9_-]+)\/attack$/u.exec(path);
          let body;
          try {
            body = JSON.parse(init.body);
          } catch {
            /* Unsupported or malformed mutations receive no actor admission. */
          }
          const pending = entry.assistant?.exportState()?.pending;
          if (
            match &&
            pending?.kind === "attack" &&
            pending.battleId === match[1] &&
            pending.operationId === body?.operationId
          )
            automationAttempt = {
              playerId: entry.playerId,
              kind: "boss.attack",
              commandId: pending.commandId,
              attemptId: pending.attemptId,
              operationId: pending.operationId,
              battleId: pending.battleId,
            };
        }
        const requestHeaders = new Headers(init.headers);
        requestHeaders.delete("X-Madhouse-Allow-Mutations");
        const dispatchGeneration = entry.autoStartGeneration ?? 0;
        const credential = entry.credential;
        const response = await fetcher(url, {
          ...init,
          headers: requestHeaders,
          ...(automationAttempt
            ? { madhouseAutomationAttempt: automationAttempt }
            : {}),
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
            return (
              dispatchGeneration === (entry.autoStartGeneration ?? 0) &&
              canAct(entry)
            );
          },
        }).catch((error) => {
          if (error.notDispatched && init.method === "POST")
            entry.assistant?.releaseUnsent(
              JSON.parse(init.body || "null")?.operationId,
            );
          throw error;
        });
        const automated = () =>
          !closed &&
          !entry.storageFailed &&
          canAct(entry) &&
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
      canSendMutation: () => canAct(entry) && !entry.equipment?.pending,
      getPlayerIdentity: () => entry.player,
    });
    if (saved?.battle) entry.controller.restoreState(saved.battle);
    entry.goal = createBossBattleGoal({ controller: entry.controller, now });
    const restoredGoal = restoredShopDropGoal(saved?.goalRecord);
    if (restoredGoal) entry.goal.restoreState(restoredGoal);
    if (saved?.raid?.stopAfterBattle) entry.goal.finishCurrentBattle();
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
      available: () => !closed && !entry.storageFailed && canAct(entry),
      priorityActive: () => characterPriorityActive(entry),
      readAvailable: () =>
        !closed && !entry.storageFailed && Boolean(entry.credential),
      refreshAvailability,
      canReconcileStart: () => {
        try {
          return (
            (store.readRoutePolicy?.(entry.playerId)?.policy ?? "direct") ===
            "direct"
          );
        } catch {
          return false;
        }
      },
      onChange: () => save(entry),
    });
    const startAssistant = () =>
      entry.assistant.begin(
        `${entry.controller.getSnapshot().boss?.id}:${entry.goal.getSnapshot()?.startedAt ?? "single"}`,
      );
    entry.auto = createBattleSeries({
      controller: {
        ...entry.controller,
        attack: (options) => entry.assistant.step(options),
        start: () => entry.assistant.startBattle(),
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
    });
    entry.collector = createBusinessCollector({
      helper: entry.businessHelper,
      controller: entry.controller,
      goal: entry.goal,
      auto: entry.auto,
      getCatalogue: getBusinessCatalogue,
      getBoss,
      priorityActive: () => characterPriorityActive(entry),
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
        !entry.inventoryBusy &&
        !entry.equipment?.pending &&
        !entry.characterUpgrade.pending &&
        (!entry.characterBatch?.running() ||
          Boolean(entry.workFarm?.getSnapshot().run?.pending)) &&
        !entry.businessHelper.run?.pendingUpgrade &&
        !entry.controller.getSnapshot().pending &&
        (mode === "energy" ||
          (!entry.auto.getSnapshot().enabled &&
            !entry.collector.running() &&
            entry.controller.getSnapshot().battle?.status !== "active")),
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
      request: async (method, path, body, { signal } = {}) => {
        if (closed || entry.storageFailed || !entry.credential)
          throw failure(503, "automation_stopped");
        save(entry);
        if (entry.storageFailed)
          throw failure(503, "automation_storage_unavailable");
        const response = await fetcher(`https://cargohustle.online${path}`, {
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
        });
        if (!response.ok)
          throw failure(
            response.status,
            `Сервис работёнок временно недоступен (HTTP ${response.status}). Запрос не повторён.`,
          );
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
      priorityActive: () => characterPriorityActive(entry),
      available: () =>
        !closed &&
        !entry.storageFailed &&
        Boolean(entry.credential) &&
        canAct(entry),
      lock: () => {
        if (
          entry.busy ||
          (characterPriorityActive(entry) &&
            !characterBattleUncertain(
              entry.controller.getSnapshot(),
              entry.assistant.projection(),
            ))
        )
          return false;
        entry.busy = true;
        return true;
      },
      unlock: () => {
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
        if (!allowed() || !entry.goal.canStart()) return;
        if (!entry.controller.allowSoloContinuation()) return;
        startAssistant();
        await entry.assistant.startBattle({
          next: Boolean(entry.controller.getSnapshot().battle),
          allowed,
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
      priorityActive: () => characterPriorityActive(entry),
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      lock: () => {
        if (
          entry.busy ||
          entry.inventoryBusy ||
          entry.storageFailed ||
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
        return "finished";
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
      priorityActive: () => characterPriorityActive(entry),
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      now,
    });
    entry.characterBatch = createCharacterStatBatch({
      state: entry.characterUpgrade,
      read: () => readCharacterProfile(entry, entry.credential),
      step: (quote, allowed, confirmed) =>
        submitCharacterPoint(entry, quote, allowed, confirmed),
      persist: () => {
        save(entry);
        return !entry.storageFailed;
      },
      lock: () => {
        if (
          entry.busy ||
          entry.inventoryBusy ||
          entry.storageFailed ||
          store.isRestoreRequired(entry.playerId) ||
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
    if (
      entry.credential &&
      entry.characterBatch.running() &&
      !store.isRestoreRequired(playerId)
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
      const unresolved = entry.controller.getSnapshot().pendingInvitation;
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
          } catch {
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
      throw failure(error.status || 502, "invitations_unavailable");
    }
  }
  async function refreshPendingFriend(entry) {
    if (
      closed ||
      entry.storageFailed ||
      !entry.credential ||
      entry.busy ||
      entry.inventoryBusy ||
      entry.raidFriendRefreshing ||
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
      (invitation.leaderPlayerId !== expected.leaderPlayerId ||
        invitation.inviterPlayerId !== expected.inviterPlayerId ||
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
      const goal = entry.goal.getSnapshot();
      if (
        goal &&
        (goal.boss.id !== invitation.bossId || goal.status !== "active")
      )
        entry.goal.reset();
      if (!allowed() || !canAct(entry)) throw failure(409, "raid_stopped");
      await entry.controller.acceptInvitation(boss, invitation);
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
      assertIdentityAllowed(cached.playerId, authorization, entry);
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
      assertIdentityAllowed(playerId, authorization, entry);
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
  async function identifyOwner(ownerId) {
    if (closed) throw failure(503, "automation_unavailable");
    ensureLease();
    const normalizedOwnerId = String(ownerId ?? "");
    if (
      !/^[1-9][0-9]{0,15}$/.test(normalizedOwnerId) ||
      !Number.isSafeInteger(Number(normalizedOwnerId))
    )
      throw failure(401, "game_session_required");
    let binding;
    let recovery;
    let bootstrap;
    try {
      binding = store.readGameAccountBinding(normalizedOwnerId);
      recovery = store.readGameAuthRecovery(normalizedOwnerId);
      bootstrap = store.readGameAuthBootstrap?.(normalizedOwnerId) || null;
    } catch {
      throw failure(503, "automation_storage_unavailable");
    }
    const bootstrapAfterLogout = Boolean(
      recovery?.state === "logged_out" &&
      bootstrap?.state === "ready" &&
      bootstrap.authGeneration > recovery.authGeneration &&
      bootstrap.consentGeneration > recovery.consentGeneration,
    );
    if (
      !binding ||
      (bootstrap && bootstrap.state !== "ready") ||
      (recovery && recovery.state !== "ready" && !bootstrapAfterLogout)
    )
      throw failure(401, "game_session_required");
    const entry = await actor(String(binding.playerId));
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    if (!entry.credential) throw failure(401, "game_session_required");
    const identified = await identify(entry.credential);
    const currentBinding = store.readGameAccountBinding(normalizedOwnerId);
    const currentBootstrap =
      store.readGameAuthBootstrap?.(normalizedOwnerId) || null;
    const currentRecovery = store.readGameAuthRecovery(normalizedOwnerId);
    const currentBootstrapAfterLogout = Boolean(
      currentRecovery?.state === "logged_out" &&
      currentBootstrap?.state === "ready" &&
      currentBootstrap.authGeneration > currentRecovery.authGeneration &&
      currentBootstrap.consentGeneration > currentRecovery.consentGeneration,
    );
    if (
      currentBinding?.playerId !== binding.playerId ||
      (currentBootstrap && currentBootstrap.state !== "ready") ||
      (currentRecovery &&
        currentRecovery.state !== "ready" &&
        !currentBootstrapAfterLogout) ||
      (bootstrap?.operationId &&
        currentBootstrap?.operationId !== bootstrap.operationId) ||
      (recovery?.operationId &&
        currentRecovery?.operationId !== recovery.operationId)
    )
      throw failure(401, "game_session_required");
    return identified;
  }
  async function adoptGameCredential({
    ownerId,
    playerId,
    authOperationId,
    bootstrapOperationId,
    authGeneration,
    consentGeneration,
    routeEpoch,
    credentialVersion,
    accessToken,
    profile,
    restored = false,
  } = {}) {
    if (closed) throw failure(503, "automation_unavailable");
    ensureLease();
    const normalizedPlayerId = String(playerId ?? "");
    const normalizedTelegramId =
      typeof profile?.telegramId === "number" &&
      Number.isSafeInteger(profile.telegramId) &&
      profile.telegramId > 0
        ? String(profile.telegramId)
        : typeof profile?.telegramId === "string" &&
            /^[1-9][0-9]{0,15}$/.test(profile.telegramId) &&
            Number.isSafeInteger(Number(profile.telegramId))
          ? profile.telegramId
          : null;
    if (
      typeof ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/.test(ownerId) ||
      !Number.isSafeInteger(Number(ownerId)) ||
      normalizedTelegramId !== ownerId ||
      !positive(Number(normalizedPlayerId)) ||
      String(profile?.playerId) !== normalizedPlayerId ||
      typeof authOperationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        authOperationId,
      ) ||
      !positive(authGeneration) ||
      !positive(consentGeneration) ||
      typeof restored !== "boolean" ||
      (restored && (!bootstrapOperationId || routeEpoch !== 1)) ||
      (bootstrapOperationId
        ? !restored && routeEpoch !== 0
        : !positive(routeEpoch)) ||
      (bootstrapOperationId != null &&
        (typeof bootstrapOperationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
            bootstrapOperationId,
          ))) ||
      !positive(credentialVersion) ||
      typeof accessToken !== "string" ||
      accessToken.length > 16_384 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(accessToken)
    )
      throw failure(400, "game_auth_credential_invalid");
    const assertAdoptable = () => {
      const binding = store.readGameAccountBinding(ownerId);
      const route = store.readRoutePolicy(normalizedPlayerId);
      if (bootstrapOperationId) {
        const bootstrap = store.readGameAuthBootstrap(ownerId);
        const recovery = store.readGameAuthRecovery(ownerId);
        const bootstrapAfterLogout = Boolean(
          recovery?.state === "logged_out" &&
          bootstrap?.authGeneration > recovery.authGeneration &&
          bootstrap?.consentGeneration > recovery.consentGeneration,
        );
        const consent = restored
          ? store.readRestoreOwnerConsent?.(ownerId)
          : null;
        if (
          binding?.playerId !== normalizedPlayerId ||
          (recovery && recovery.state !== "ready" && !bootstrapAfterLogout) ||
          bootstrap?.operationId !== bootstrapOperationId ||
          bootstrap.authGeneration !== authGeneration ||
          bootstrap.consentGeneration !== consentGeneration ||
          bootstrap.routeEpoch !== routeEpoch ||
          bootstrap.credentialVersion !== credentialVersion ||
          bootstrap.playerId !== normalizedPlayerId ||
          !["credential_stored", "ready"].includes(bootstrap.state) ||
          route?.policy !== "direct" ||
          route.routeEpoch !== routeEpoch ||
          (restored &&
            (!store.isRestoreGuardActive() ||
              store.isRestoreAccountReauthorized(normalizedPlayerId) ||
              consent?.requestId !== bootstrap.requestId ||
              consent.routePolicy !== "direct" ||
              authOperationId !== bootstrapOperationId))
        )
          throw failure(409, "game_auth_operation_stale");
      } else {
        const recovery = store.readGameAuthRecovery(ownerId);
        if (
          binding?.playerId !== normalizedPlayerId ||
          recovery?.operationId !== authOperationId ||
          recovery.authGeneration !== authGeneration ||
          recovery.consentGeneration !== consentGeneration ||
          recovery.routeEpoch !== routeEpoch ||
          recovery.credentialVersion !== credentialVersion ||
          !["credential_stored", "ready"].includes(recovery.state) ||
          route?.policy !== "bridge_required" ||
          route.routeEpoch !== routeEpoch
        )
          throw failure(409, "game_auth_operation_stale");
      }
    };
    assertAdoptable();
    const entry = await actor(normalizedPlayerId);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    // Actor restoration can yield; recheck all durable authorizations immediately
    // before persisting the candidate so a route switch cannot adopt a late JWT.
    ensureLease();
    assertAdoptable();
    if (restored) stopRestoredAutomation(entry);
    entry.credential = `Bearer ${accessToken}`;
    entry.player = {
      playerId: Number(normalizedPlayerId),
      nickname:
        typeof profile.nickname === "string"
          ? profile.nickname.slice(0, 80)
          : "Игрок",
    };
    save(entry);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    const hash = createHash("sha256").update(entry.credential).digest("hex");
    identities.set(hash, {
      playerId: normalizedPlayerId,
      until: now() + 5 * 60 * 1000,
    });
    if (identities.size > 500)
      identities.delete(identities.keys().next().value);
    return snapshot(entry);
  }
  function stopRestoredAutomation(entry) {
    entry.floorRunner.stop();
    entry.characterBatch.stop();
    entry.auto.stop();
    entry.collector.stop();
    entry.workFarm.stop();
    entry.raidWorker.stop(
      "paused",
      "Восстановленный аккаунт подтверждён. Прежние автоматизации остановлены; неизвестные игровые действия не повторяются.",
    );
    entry.goal.stop();
    entry.commandAdmissions = [];
    entry.commandAdmissionCompletionId = null;
  }
  async function confirmRestoredAccount({
    ownerId,
    playerId,
    authorization,
  } = {}) {
    const normalizedPlayerId = String(playerId ?? "");
    if (!store.isRestoreRequired(normalizedPlayerId)) return false;
    const entry = await identify(authorization);
    if (entry.playerId !== normalizedPlayerId)
      throw failure(403, "automation_restore_account_mismatch");
    const binding = store.readGameAccountOwner(normalizedPlayerId);
    if (binding?.ownerId !== String(ownerId ?? ""))
      throw failure(403, "automation_restore_owner_mismatch");
    ensureLease();
    stopRestoredAutomation(entry);
    save(entry);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    store.confirmRestoredAccount({
      ownerId: binding.ownerId,
      playerId: normalizedPlayerId,
      verifiedAt: now(),
    });
    return true;
  }
  async function logoutGameSession({
    ownerId,
    playerId,
    operationId,
    authGeneration,
    consentGeneration,
  } = {}) {
    if (closed) throw failure(503, "automation_unavailable");
    ensureLease();
    const binding = store.readGameAccountBinding(ownerId);
    const recovery = store.readGameAuthRecovery(ownerId);
    if (
      binding?.playerId !== String(playerId) ||
      recovery?.operationId !== operationId ||
      recovery.authGeneration !== authGeneration ||
      recovery.consentGeneration !== consentGeneration ||
      !["logout_pending", "logged_out"].includes(recovery.state)
    )
      throw failure(409, "game_auth_operation_stale");

    for (const [credentialHash, identity] of identities) {
      if (identity.playerId === String(playerId))
        identities.delete(credentialHash);
    }
    const entry = await actor(String(playerId));
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    entry.credential = null;
    entry.player = null;
    entry.auto.stop();
    entry.collector.stop();
    entry.workFarm.stop();
    entry.raidWorker.stop(
      "paused",
      "Игровой вход закрыт. Подключите аккаунт заново перед новыми действиями.",
    );
    save(entry);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    return { status: "logged_out", playerId: String(playerId) };
  }
  async function pauseForRouteChange({ ownerId, previous } = {}) {
    if (closed) throw failure(503, "automation_worker_unavailable");
    const binding = store.readGameAccountBinding?.(ownerId);
    if (!binding) return false;
    const playerId = String(binding.playerId);
    const route = store.readRoutePolicy(playerId);
    if (
      !route ||
      route.routeEpoch !== previous?.routeEpoch ||
      route.policy !== previous.policy ||
      route.activeDeviceId !== previous.activeDeviceId
    )
      throw failure(409, "automation_route_epoch_conflict");

    const loaded = actors.get(playerId);
    if (loaded?.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    const saved = store.read(playerId) ?? {};
    const hasRunningAutomation =
      saved.auto?.enabled ||
      saved.raid?.enabled ||
      saved.businessHelper?.run?.status === "running" ||
      saved.workFarm?.run?.status === "running" ||
      loaded?.auto.getSnapshot().enabled ||
      loaded?.raidWorker.getSnapshot().enabled ||
      loaded?.collector.running() ||
      loaded?.workFarm.getSnapshot().run?.status === "running";
    if (!hasRunningAutomation) return false;

    ensureLease();
    const entry = loaded ?? (await actor(playerId));
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    const latestRoute = store.readRoutePolicy(playerId);
    if (
      !latestRoute ||
      latestRoute.routeEpoch !== previous.routeEpoch ||
      latestRoute.policy !== previous.policy ||
      latestRoute.activeDeviceId !== previous.activeDeviceId
    )
      throw failure(409, "automation_route_epoch_conflict");

    entry.restoring = true;
    try {
      entry.raidWorker.stop(
        "paused",
        "Маршрут Wiki меняется. Автоматизации остановлены; после подключения компьютера проверьте состояние и запустите их вручную.",
      );
      entry.collector.stop();
      entry.workFarm.stop();
      entry.auto.stop();
    } finally {
      entry.restoring = false;
    }
    save(entry);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    return true;
  }
  function configureAutoGoal(entry, settingsInput, state) {
    if (settingsInput == null) return;
    if (!state.boss || settingsInput.bossId !== state.boss.id)
      throw failure(400, "goal_boss_mismatch");
    if (entry.auto.getSnapshot().enabled)
      throw failure(409, "automation_controls_the_battle");
    const resolved = resolveBossGoal(settingsInput, state.boss);
    const settings = {
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
    const previous = entry.goal.exportState()?.settings;
    const unchanged =
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
      JSON.stringify(previous.items) === JSON.stringify(settings.items);
    if (!unchanged) entry.goal.configure(settings);
  }
  function commandAdmissionContext(entry) {
    const route = store.readRoutePolicy?.(entry.playerId) ?? {
      policy: "direct",
      routeEpoch: 0,
    };
    const owner = store.readGameAccountOwner?.(entry.playerId) ?? null;
    if (route.policy === "bridge_required" && !owner)
      throw failure(409, "automation_command_owner_unbound");
    if (
      typeof store.commandAdmissionOwnerRef !== "function" ||
      typeof store.commandAdmissionPlayerRef !== "function"
    )
      throw failure(503, "automation_command_admission_unavailable");
    return {
      route,
      ownerRef: owner ? store.commandAdmissionOwnerRef(owner.ownerId) : null,
      playerRef: store.commandAdmissionPlayerRef(entry.playerId),
    };
  }

  function issueCommandTicket(entry, input) {
    if (
      !input ||
      typeof input !== "object" ||
      !commands.has(input.command) ||
      commandControlCommands.has(input.command) ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      throw failure(400, "invalid_automation_command_ticket_request");
    if (Object.hasOwn(input, "id") || Object.hasOwn(input, "admissionTicket"))
      throw failure(400, "automation_command_id_server_generated");
    ensureLease();
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    const pendingAttack = entry.assistant.exportState().pending;
    if (
      pendingAttack &&
      !readOnlyWhilePending.has(input.command) &&
      !characterIntentWhileAttackPending(input.command, pendingAttack) &&
      !(
        input.command === "healing.ack" &&
        ["heal", "buy", "invite"].includes(pendingAttack.kind)
      )
    )
      throw failure(409, "battle_action_unresolved");
    if (entry.busy || entry.inventoryBusy)
      throw failure(409, "automation_command_pending");
    if (
      input.expectedVersion !== entry.version ||
      !Number.isSafeInteger(entry.version + 1)
    )
      throw failure(409, "automation_state_changed");
    if (
      store.isRestoreRequired(entry.playerId) &&
      !readOnlyWhilePending.has(input.command) &&
      !(
        restoreReconciliationCommands.has(input.command) &&
        store.isRestoreAccountReauthorized(entry.playerId) &&
        store.hasExplicitRoutePolicy(entry.playerId)
      )
    )
      throw failure(409, "automation_restore_confirmation_required");
    const args = input.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw failure(400, "invalid_command_arguments");
    const argumentsDigest = commandArgumentsDigest(args);
    if (typeof store.signCommandAdmissionTicket !== "function")
      throw failure(503, "automation_command_admission_unavailable");
    const issuedAt = now();
    const expiresAt = issuedAt + commandAdmissionTtlMs;
    const context = commandAdmissionContext(entry);
    entry.commandAdmissions = entry.commandAdmissions.filter(
      (admission) => admission.expiresAt > issuedAt,
    );
    if (entry.commandAdmissions.length >= MAX_COMMAND_ADMISSIONS)
      throw failure(429, "automation_command_admissions_full");
    const id = randomUUID();
    const intentVersion = entry.version + 1;
    const payload = {
      version: 1,
      id,
      playerRef: context.playerRef,
      ownerRef: context.ownerRef,
      command: input.command,
      argumentsDigest,
      intentVersion,
      routeEpoch: context.route.routeEpoch,
      issuedAt,
      expiresAt,
    };
    const ticket = store.signCommandAdmissionTicket(payload);
    entry.commandAdmissions.push({
      id,
      command: input.command,
      argumentsDigest,
      intentVersion,
      routeEpoch: context.route.routeEpoch,
      issuedAt,
      expiresAt,
      state: "issued",
      result: null,
    });
    save(entry);
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    return { id, ticket, intentVersion, expiresAt };
  }

  function resolveCommandAdmission(entry, input, context) {
    if (typeof input.admissionTicket !== "string") return null;
    if (typeof store.verifyCommandAdmissionTicket !== "function")
      throw failure(503, "automation_command_admission_unavailable");
    const payload = store.verifyCommandAdmissionTicket(input.admissionTicket);
    if (!payload || payload.version !== 1 || typeof payload.id !== "string")
      throw failure(403, "automation_command_admission_invalid");
    if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now())
      throw failure(409, "automation_command_admission_expired");
    const argsDigest = commandArgumentsDigest(input.args ?? {});
    if (
      payload.playerRef !== context.playerRef ||
      payload.ownerRef !== context.ownerRef ||
      payload.command !== input.command ||
      payload.argumentsDigest !== argsDigest ||
      payload.intentVersion !== input.expectedVersion ||
      payload.routeEpoch !== context.route.routeEpoch ||
      (input.id !== undefined && input.id !== payload.id)
    )
      throw failure(403, "automation_command_admission_mismatch");
    const admission = entry.commandAdmissions.find(
      (candidate) => candidate.id === payload.id,
    );
    if (
      !admission ||
      admission.expiresAt !== payload.expiresAt ||
      admission.command !== payload.command ||
      admission.argumentsDigest !== payload.argumentsDigest ||
      admission.intentVersion !== payload.intentVersion ||
      admission.routeEpoch !== payload.routeEpoch
    )
      throw failure(409, "automation_command_admission_unknown");
    if (admission.state === "completed" && admission.result)
      return { admission, completed: true };
    if (admission.state !== "issued")
      throw failure(409, "automation_command_already_received");
    if (input.expectedVersion !== entry.version)
      throw failure(409, "automation_state_changed");
    return { admission, completed: false };
  }

  async function command(entry, input) {
    if (
      !input ||
      typeof input !== "object" ||
      !commands.has(input.command) ||
      !Number.isSafeInteger(input.expectedVersion)
    )
      throw failure(400, "invalid_automation_command");
    if (
      input.id !== undefined &&
      (typeof input.id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/u.test(input.id))
    )
      throw failure(400, "invalid_automation_command");
    ensureLease();
    if (entry.storageFailed)
      throw failure(503, "automation_storage_unavailable");
    const route = store.readRoutePolicy?.(entry.playerId) ?? {
      policy: "direct",
      routeEpoch: 0,
    };
    const controlCommand = commandControlCommands.has(input.command);
    const ticketRequired =
      route.policy === "bridge_required" && !controlCommand;
    if (ticketRequired && typeof input.admissionTicket !== "string")
      throw failure(409, "automation_command_admission_required");
    if (controlCommand && input.admissionTicket !== undefined)
      throw failure(400, "automation_command_admission_not_required");
    const admissionContext = input.admissionTicket
      ? commandAdmissionContext(entry)
      : null;
    const admissionResolution = admissionContext
      ? resolveCommandAdmission(entry, input, admissionContext)
      : null;
    if (!admissionResolution && !controlCommand && typeof input.id !== "string")
      throw failure(400, "invalid_automation_command");
    const commandId = admissionResolution
      ? admissionResolution.admission.id
      : (input.id ?? randomUUID());
    if (admissionResolution?.completed)
      return {
        ...snapshot(entry),
        commandReceipt: structuredClone(admissionResolution.admission.result),
      };
    const battlePending = entry.assistant.exportState().pending;
    const stopWhilePending = commandControlCommands;
    const restoreConfirmed = store.isRestoreAccountReauthorized(entry.playerId);
    if (
      store.isRestoreRequired(entry.playerId) &&
      !readOnlyWhilePending.has(input.command) &&
      !stopWhilePending.has(input.command) &&
      !(
        restoreReconciliationCommands.has(input.command) &&
        restoreConfirmed &&
        store.hasExplicitRoutePolicy(entry.playerId)
      ) &&
      !(restoreConfirmed && input.command === "healing.ack")
    )
      throw failure(409, "automation_restore_confirmation_required");
    const canAcknowledgePending =
      input.command === "healing.ack" &&
      ["heal", "buy", "invite"].includes(battlePending?.kind);
    if (
      battlePending &&
      !readOnlyWhilePending.has(input.command) &&
      !characterIntentWhileAttackPending(input.command, battlePending) &&
      !stopWhilePending.has(input.command) &&
      !canAcknowledgePending
    )
      throw failure(409, "battle_action_unresolved");
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
        "work.stop",
        "work.refresh",
        "auto.stop",
        "raid.stop",
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
    if (entry.receipts.includes(commandId))
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
        "subscription.stop",
        "auto.stop",
        "goal.stop",
        "business.run.stop",
        "character.stop",
        "character.upgrade",
        "character.start",
        "character.startAll",
        "work.stop",
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
      entry.raidSubscription.getSnapshot().checkpoint &&
      ![
        "floor.stop",
        "subscription.stop",
        "buddy.set",
        "buddy.order",
        "buddy.configure",
        "buddy.resolve",
        "invitations.refresh",
        "friends.reconcile",
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
      entry.collector.running() &&
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
      entry.raidWorker.getSnapshot().enabled &&
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
      entry.equipment?.pending &&
      ![
        "equipment.refresh",
        "inventory.refresh",
        "character.upgrade",
        "character.start",
        "character.startAll",
      ].includes(input.command) &&
      !safeCommands.has(input.command)
    )
      throw failure(409, "weapon_equipment_uncertain");
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
    let restoreSaveCheck = null;
    entry.busy = true;
    if (!controlCommand || route.policy !== "bridge_required")
      entry.receipts = [...entry.receipts.slice(-127), commandId];
    if (admissionResolution) admissionResolution.admission.state = "consumed";
    save(entry);
    try {
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      if (
        ["auto.stop", "goal.stop", "business.run.stop"].includes(
          input.command,
        ) ||
        (input.command === "raid.stop" && state.battle?.status !== "active")
      )
        entry.autoStartGeneration = (entry.autoStartGeneration ?? 0) + 1;
      switch (input.command) {
        case "buddy.resolve": {
          if (!["booster", "stash"].includes(args.kind))
            throw failure(400, "invalid_buddy_resolution");
          const helper = entry.buddyHelp;
          const credential = entry.credential;
          restoreSaveCheck = {
            epoch: store.readRestoreGuardEpoch(),
            ownerId:
              store.readGameAccountOwner(entry.playerId)?.ownerId ?? null,
            route: store.readRoutePolicy(entry.playerId),
          };
          const checkCredential = () => {
            if (entry.credential !== credential)
              throw failure(409, "automation_restore_account_changed");
          };
          if (args.kind === "booster") {
            const pending = helper.pending;
            if (!pending) throw failure(409, "buddy_no_pending_action");
            const response = await gameJson(
              credential,
              "/api/player-interactions/booster-requests/incoming?limit=100",
            );
            checkCredential();
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
              credential,
              `/api/stash/help-requests/${pending.playerId}`,
            );
            checkCredential();
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
          entry.floorRunner.stop();
          entry.raidSubscription.discardFloorCheckpoint();
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
          entry.raidSubscription.stop();
          break;
        case "inventory.action":
        case "inventory.refresh":
          await inventoryAction({
            entry,
            args,
            commandId,
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
            commandId,
            refreshOnly: input.command === "equipment.refresh",
            fetcher,
            save,
          });
          break;
        case "raid.start": {
          const startGeneration = entry.autoStartGeneration ?? 0;
          if (
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
          await refreshAutoDamageLimit(entry);
          if (startGeneration !== (entry.autoStartGeneration ?? 0)) break;
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
        case "raid.stop":
          entry.raidWorker.finishAfterCurrent();
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
          entry.workFarm.stop();
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
          if (entry.assistant.exportState().pending?.kind === "attack")
            await entry.assistant.recover();
          else await entry.controller.refresh();
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
          entry.activeAttackCommandId = commandId;
          await entry.assistant.attackManually();
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
          entry.auto.stop();
          if (entry.raidWorker.getSnapshot().enabled) entry.raidWorker.stop();
          entry.controller.preparePurchase(
            args.type,
            args.currency,
            args.quantity,
          );
          break;
        case "purchase.cancel":
          entry.controller.cancelPurchase();
          break;
        case "purchase.buy":
          await entry.assistant.buy(entry.controller.getSnapshot().purchase);
          break;
        case "purchase.ack":
          entry.controller.acknowledgePurchase();
          break;
        case "auto.start": {
          const startGeneration = entry.autoStartGeneration ?? 0;
          configureAutoGoal(entry, args.settings, state);
          await refreshAutoDamageLimit(entry);
          if (startGeneration !== (entry.autoStartGeneration ?? 0)) break;
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
            if (args.settings != null && !started)
              throw failure(409, "automation_start_unavailable");
          }
          break;
        }
        case "auto.stop":
          if (entry.raidWorker.getSnapshot().enabled) entry.raidWorker.stop();
          entry.collector.stop();
          entry.auto.stop();
          entry.goal.stop({ clearProgress: true });
          break;
        case "goal.configure": {
          if (!state.boss || args.bossId !== state.boss.id)
            throw failure(400, "goal_boss_mismatch");
          entry.auto.stop();
          entry.goal.configure(resolveBossGoal(args, state.boss));
          break;
        }
        case "goal.stop":
          if (entry.raidWorker.getSnapshot().enabled) entry.raidWorker.stop();
          entry.collector.stop();
          entry.auto.stop();
          entry.goal.stop();
          break;
        case "goal.reset":
          entry.auto.stop();
          entry.goal.reset();
          break;
        case "pvp.refresh":
          await refreshPvp(entry);
          break;
        case "business.run.stop":
          entry.collector.stop();
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
              const run = helper.run;
              const business = catalogue.businesses.find(
                (item) => item.id === args.businessId,
              );
              if (
                store.isRestoreRequired(entry.playerId) &&
                store.isRestoreAccountReauthorized(entry.playerId) &&
                store.hasExplicitRoutePolicy(entry.playerId) &&
                run?.businessId === args.businessId &&
                run.pendingUpgrade &&
                Number(business?.apiId) === run.pendingUpgrade.businessId
              ) {
                const credential = entry.credential;
                const expectedRoute = store.readRoutePolicy(entry.playerId);
                const result = await advanceBusinessUpgrade({
                  run,
                  businessId: run.pendingUpgrade.businessId,
                  get: (path) => gameJson(credential, path),
                  post: () => {
                    throw new Error("restore_reconciliation_must_not_mutate");
                  },
                  allowed: () => false,
                  persist: () => {
                    const currentRoute = store.readRoutePolicy(entry.playerId);
                    if (
                      entry.credential !== credential ||
                      !store.isRestoreAccountReauthorized(entry.playerId) ||
                      !store.hasExplicitRoutePolicy(entry.playerId) ||
                      currentRoute.policy !== expectedRoute.policy ||
                      currentRoute.routeEpoch !== expectedRoute.routeEpoch ||
                      currentRoute.activeDeviceId !==
                        expectedRoute.activeDeviceId
                    )
                      return false;
                    save(entry);
                    return !entry.storageFailed;
                  },
                });
                helper.notice =
                  result.status === "confirmed"
                    ? "Игра подтвердила повышение уровня. Проверьте состояние бизнеса перед продолжением."
                    : "Результат повышения не подтверждён; повторная отправка заблокирована.";
              }
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
      if (admissionResolution)
        entry.commandAdmissionCompletionId = admissionResolution.admission.id;
      save(entry, restoreSaveCheck);
      entry.commandAdmissionCompletionId = null;
      if (entry.storageFailed)
        throw failure(503, "automation_storage_unavailable");
      const result = snapshot(entry);
      if (admissionResolution)
        result.commandReceipt = structuredClone(
          admissionResolution.admission.result,
        );
      return result;
    } finally {
      if (entry.activeAttackCommandId === commandId)
        entry.activeAttackCommandId = null;
      entry.busy = wasBusy;
    }
  }
  function beginDrain() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    for (const entry of actors.values()) {
      entry.floorRunner.dispose();
      entry.characterBatch.dispose();
      entry.workFarm.dispose();
      entry.collector.dispose();
      entry.auto.dispose();
      entry.goal.dispose();
    }
  }

  return {
    identify,
    identifyOwner,
    admitGameMutation,
    bindGameMutationConnection,
    adoptGameCredential,
    confirmRestoredAccount,
    logoutGameSession,
    pauseForRouteChange,
    launch,
    snapshot,
    issueCommandTicket,
    command,
    beginDrain,
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
          try {
            if (store.isRestoreRequired(entry.playerId)) continue;
          } catch {
            // Unreadable restore state fails closed for this account only.
            continue;
          }
          discoverInvitations(entry);
          void refreshPendingFriend(entry);
          void entry.raidSubscription.tick().catch(() => {});
          const buddy = entry.raidSubscription.getSnapshot();
          if (
            !entry.busy &&
            !entry.inventoryBusy &&
            !characterPriorityActive(entry) &&
            entry.workFarm.canSuspend() &&
            !entry.workFarm.getSnapshot().manualPending &&
            !entry.storageFailed &&
            entry.credential &&
            now() >= entry.buddyHelpNextAt &&
            (entry.buddyHelp.pending ||
              entry.buddyHelp.stashPending ||
              (buddy.mode === "buddy" &&
                buddy.enabled &&
                !buddy.checkpoint &&
                (entry.buddyHelp.boostersEnabled ||
                  entry.buddyHelp.stashEnabled)))
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
            const allowed = () => {
              ensureLease();
              const current = entry.raidSubscription.getSnapshot();
              return (
                !closed &&
                !entry.storageFailed &&
                current.mode === "buddy" &&
                current.enabled &&
                accountHealth(entry.credential)?.status !==
                  "credentials_invalid" &&
                !current.checkpoint &&
                (chooseStash
                  ? entry.buddyHelp.stashEnabled
                  : entry.buddyHelp.boostersEnabled)
              );
            };
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
        if (store.isRestoreRequired(playerId)) continue;
        if (!canUseAccountSession(playerId)) continue;
        // Discovery is server-owned and continues even when no browser is open.
        if (value?.credential) await actor(playerId);
        if (value?.credential && value?.floorRunner?.phase === "launching") {
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
      beginDrain();
      if (disposed) return;
      disposed = true;
      for (const entry of actors.values()) {
        for (const unsub of entry.unsubscribers) unsub();
        entry.controller.reset();
      }
      store.releaseLease(owner);
      actors.clear();
      identities.clear();
    },
  };
}
