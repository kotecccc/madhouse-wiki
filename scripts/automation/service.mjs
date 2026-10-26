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
import { createBusinessCollector } from "./business-collector.mjs";
import { createBattleSeries } from "./battle-series.mjs";
import { createBossBattleRequest } from "../../src/features/bosses/BossBattle/boss-battle-request.js";
import { normalizePvpBattle } from "../../src/features/combat/ActiveBattleDock/active-battle-state.js";
import { normalizeActiveBossBattle } from "../../shared/active-boss-battle.js";
import {
  BOSS_INVITATIONS_PATH,
  projectBossInvitations,
} from "./boss-invitations.mjs";

const failure = (status, code) => Object.assign(new Error(code), { status });
const positive = (id) => Number.isSafeInteger(id) && id > 0;
const safeCommands = new Set([
  "inventory.refresh",
  "raid.stop",
  "invitations.refresh",
  "business.run.stop",
  "work.stop",
  "work.refresh",
  "auto.stop",
  "goal.stop",
  "pvp.refresh",
  "business.select",
  "business.refresh",
]);
const commands = new Set([
  "inventory.action",
  "inventory.refresh",
  "equipment.weapon",
  "equipment.refresh",
  "raid.start",
  "raid.stop",
  "invitations.refresh",
  "invitations.accept",
  "work.refresh",
  "work.plan",
  "work.start",
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
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
}) {
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
  let heartbeat = null;
  const owner = randomUUID();
  function ensureLease() {
    if (closed || !store.acquireLease(owner, now(), 15000))
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
  function persisted(entry) {
    return {
      version: entry.version,
      credential: entry.credential,
      player: entry.player,
      battle: entry.controller.getSnapshot(),
      goalRecord: entry.goal.exportState(),
      businessHelper: entry.businessHelper,
      workFarm: entry.workFarm.exportState(),
      auto: entry.auto.exportState(),
      assistant: entry.assistant.exportState(),
      pvp: entry.pvp,
      equipment: entry.equipment,
      preferences: entry.preferences,
      invitations: entry.invitations,
      raid: entry.raidWorker.getSnapshot(),
      receipts: entry.receipts,
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
  function updateGoal(entry) {
    entry.goal.tick();
    const goal = entry.goal.getSnapshot();
    if (goal && goal.status !== "active" && entry.auto.getSnapshot().enabled)
      entry.auto.stop();
    return goal;
  }
  function canAct(entry) {
    if (accountHealth(entry.credential)?.status === "credentials_invalid")
      return false;
    const goal = updateGoal(entry);
    if (entry.collector && !entry.collector.withinTime()) return false;
    return !(
      goal?.deadlineAt != null &&
      now() >= goal.deadlineAt &&
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
      preferences: entry.preferences,
      workFarm: entry.workFarm.getSnapshot(),
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
      credential: saved?.credential ?? null,
      player: saved?.player ?? null,
      equipment: saved?.equipment ?? { pending: null, checked: false },
      preferences: saved?.preferences ?? { favoriteBossIds: [] },
      invitations: saved?.invitations ?? {
        items: [],
        loaded: false,
        refreshedAt: null,
        notice: null,
      },
      receipts: saved?.receipts ?? [],
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
      get: (path) => gameJson(entry.credential, path),
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
      available: () =>
        !closed &&
        !entry.storageFailed &&
        Boolean(entry.credential) &&
        canAct(entry),
      lock: () => {
        if (entry.busy) return false;
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
      onChange: () => save(entry),
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
    actors.set(playerId, entry);
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
        if (
          Object.hasOwn(me, "activeBossBattle") &&
          me.activeBossBattle === null
        )
          entry.controller.clearExpiredInvitation();
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
      save(entry);
    } catch (error) {
      entry.invitations.notice =
        "Не удалось обновить приглашения. Попробуйте позже.";
      save(entry);
      throw failure(error.status || 502, "invitations_unavailable");
    }
  }
  async function acceptInvitation(entry, invitationId, allowed = () => true) {
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
        await entry.controller.refresh();
      }
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
  async function command(entry, input) {
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
    // A command receipt is committed BEFORE action dispatch. Never replay it after a restart.
    if (entry.receipts.includes(input.id))
      throw failure(409, "automation_command_already_received");
    if (
      (entry.busy || entry.inventoryBusy) &&
      ![
        "raid.stop",
        "auto.stop",
        "goal.stop",
        "business.run.stop",
        "work.stop",
      ].includes(input.command)
    )
      throw failure(409, "automation_command_pending");
    if (
      !safeCommands.has(input.command) &&
      input.expectedVersion !== entry.version
    )
      throw failure(409, "automation_state_changed");
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
      !["equipment.refresh", "inventory.refresh"].includes(input.command) &&
      !safeCommands.has(input.command)
    )
      throw failure(409, "weapon_equipment_uncertain");
    const args = input.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw failure(400, "invalid_command_arguments");
    updateGoal(entry);
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
      if (
        ["auto.stop", "raid.stop", "goal.stop", "business.run.stop"].includes(
          input.command,
        )
      )
        entry.autoStartGeneration = (entry.autoStartGeneration ?? 0) + 1;
      switch (input.command) {
        case "inventory.action":
        case "inventory.refresh":
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
          entry.raidWorker.stop();
          entry.goal.stop({ clearProgress: true });
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
  return {
    identify,
    launch,
    snapshot,
    command,
    async boot() {
      ensureLease();
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
              checkpoint: value.auto,
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
    },
    close() {
      closed = true;
      for (const entry of actors.values()) {
        for (const unsub of entry.unsubscribers) unsub();
        entry.workFarm.dispose();
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
