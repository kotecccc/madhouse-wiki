import { workGameUnavailable } from "../../shared/game-health-features.js";
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
import { resolveBossGoal } from "../../src/features/bosses/BossBattle/boss-goal-options.js";
import { createBossBattleGoal } from "../../src/features/bosses/BossBattle/boss-battle-goal.js";
import { isTerminalBossBattle } from "../../src/features/bosses/BossBattle/boss-battle-status.js";
import { createWorkFarm } from "./work-farm.mjs";
import { createBusinessCollector } from "./business-collector.mjs";
import { createBattleSeries } from "./battle-series.mjs";
import { createBossBattleRequest } from "../../src/features/bosses/BossBattle/boss-battle-request.js";
import { normalizePvpBattle } from "../../src/features/combat/ActiveBattleDock/active-battle-state.js";

const failure = (status, code) => Object.assign(new Error(code), { status });
const positive = (id) => Number.isSafeInteger(id) && id > 0;
const safeCommands = new Set([
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
  let closed = false;
  let heartbeat = null;
  const owner = randomUUID();
  function ensureLease() {
    if (closed || !store.acquireLease(owner, now(), 15000))
      throw failure(503, "automation_worker_unavailable");
  }
  const gameJson = async (authorization, path) => {
    const response = await fetcher(`https://cargohustle.online${path}`, {
      headers: { Authorization: authorization, Accept: "application/json" },
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
      pvp: entry.pvp,
      preferences: entry.preferences,
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
    if (
      ["unavailable", "credentials_invalid"].includes(
        accountHealth(entry.credential)?.status,
      )
    )
      return false;
    const goal = updateGoal(entry);
    if (entry.collector && !entry.collector.withinTime()) return false;
    return !(
      goal?.deadlineAt != null &&
      now() >= goal.deadlineAt &&
      goal.status !== "stopped"
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
      isTerminalBossBattle(battle)
    )
      return;
    const reason =
      battle.expiresAt != null && battle.expiresAt <= now()
        ? "deadline"
        : battle.playerHealth === 0 || battle.bossHealth === 0
          ? "health"
          : battle.status !== "active"
            ? "status"
            : null;
    if (!reason) return;
    const key = `${battle.id}:${reason}`;
    if (entry.finishedBattleChecks.has(key)) return;
    entry.finishedBattleChecks.add(key);
    if (entry.finishedBattleChecks.size > 64)
      entry.finishedBattleChecks.delete(
        entry.finishedBattleChecks.values().next().value,
      );
    // Event-triggered GET reconciliation, once per battle/condition. No periodic
    // game scan, surrender or mutation retry, even when the result stays unknown.
    void entry.controller.refresh();
  }
  function snapshot(entry) {
    updateGoal(entry);
    reconcileFinishedBattle(entry);
    const state = entry.controller.getSnapshot();
    return {
      gameHealth: accountHealth(entry.credential),
      version: entry.version,
      serverTime: now(),
      battle: {
        ...state,
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
      preferences: saved?.preferences ?? { favoriteBossIds: [] },
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
        return fetcher(url, { ...init, redirect: "error" });
      },
    });
    entry.controller = createBossBattleController({
      request,
      now,
      canManualAttack: () =>
        !entry.auto.getSnapshot().enabled && !entry.collector?.running(),
      canStartBattle: () =>
        entry.goal.canStart() && (entry.collector?.canStartBattle() ?? true),
      canSendMutation: () => canAct(entry),
      getPlayerIdentity: () => entry.player,
    });
    if (saved?.battle) entry.controller.restoreState(saved.battle);
    entry.goal = createBossBattleGoal({ controller: entry.controller, now });
    if (saved?.goalRecord) entry.goal.restoreState(saved.goalRecord);
    entry.auto = createBattleSeries({
      controller: entry.controller,
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
      request: async (method, path, body) => {
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
          signal: AbortSignal.timeout(20000),
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
    if (
      (input.command === "work.start"
        ? workGameUnavailable(accountHealth(entry.credential))
        : ["unavailable", "credentials_invalid"].includes(
            accountHealth(entry.credential)?.status,
          )) &&
      [
        "start",
        "next",
        "attack",
        "medicine.use",
        "purchase.buy",
        "auto.start",
        "work.start",
        "business.run.start",
      ].includes(input.command)
    )
      throw failure(503, "game_unavailable_actions_paused");
    // A command receipt is committed BEFORE action dispatch. Never replay it after a restart.
    if (entry.receipts.includes(input.id))
      throw failure(409, "automation_command_already_received");
    if (
      entry.busy &&
      !["auto.stop", "goal.stop", "business.run.stop", "work.stop"].includes(
        input.command,
      )
    )
      throw failure(409, "automation_command_pending");
    if (
      !safeCommands.has(input.command) &&
      input.expectedVersion !== entry.version
    )
      throw failure(409, "automation_state_changed");
    if (
      (entry.auto.getSnapshot().enabled || entry.collector.running()) &&
      ["start", "next", "attack"].includes(input.command)
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
      entry.workFarm.running() &&
      [
        "auto.start",
        "start",
        "next",
        "attack",
        "business.run.start",
        "business.goal",
        "goal.configure",
        "medicine.use",
        "purchase.buy",
      ].includes(input.command)
    )
      throw failure(409, "work_farm_controls_resources");
    if (
      input.command === "work.start" &&
      (entry.auto.getSnapshot().enabled ||
        entry.collector.running() ||
        entry.controller.getSnapshot().pending)
    )
      throw failure(409, "automation_controls_resources");
    const args = input.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw failure(400, "invalid_command_arguments");
    updateGoal(entry);
    const state = entry.controller.getSnapshot();
    if (
      [
        "goal.configure",
        "goal.reset",
        "open",
        "favorites.set",
        "auto.start",
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
      switch (input.command) {
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
          // controller.open is UI-oriented and starts a refresh without awaiting it.
          entry.controller.open(boss, {
            refresh: !entry.auto.getSnapshot().enabled,
          });
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
          entry.collector.stop();
          entry.auto.stop();
          await entry.controller.openMedicines();
          break;
        case "medicines.close":
          entry.controller.closeMedicines();
          break;
        case "medicine.use":
          await entry.controller.useMedicine(args.type);
          break;
        case "purchase.prepare":
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
          await entry.controller.buyMedicine();
          break;
        case "purchase.ack":
          entry.controller.acknowledgePurchase();
          break;
        case "auto.start":
          if (args.settings != null) {
            if (!state.boss || args.settings.bossId !== state.boss.id)
              throw failure(400, "goal_boss_mismatch");
            if (entry.auto.getSnapshot().enabled)
              throw failure(409, "automation_controls_the_battle");
            const resolved = resolveBossGoal(args.settings, state.boss);
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
          if (
            !entry.goal.getSnapshot() ||
            entry.goal.getSnapshot().status === "active"
          ) {
            const started = entry.auto.start();
            if (args.settings != null && !started)
              throw failure(409, "automation_start_unavailable");
          }
          break;
        case "auto.stop":
          entry.collector.stop();
          entry.auto.stop();
          break;
        case "goal.configure": {
          if (!state.boss || args.bossId !== state.boss.id)
            throw failure(400, "goal_boss_mismatch");
          entry.auto.stop();
          entry.goal.configure(resolveBossGoal(args, state.boss));
          break;
        }
        case "goal.stop":
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
    snapshot,
    command,
    async boot() {
      ensureLease();
      heartbeat = setInterval(() => {
        try {
          ensureLease();
          for (const entry of actors.values()) {
            updateGoal(entry);
            entry.collector.tick();
            entry.workFarm.tick();
            reconcileFinishedBattle(entry);
          }
        } catch {
          for (const entry of actors.values()) {
            entry.storageFailed = true;
            entry.auto.stop();
            entry.workFarm.stop();
          }
        }
      }, 1000);
      heartbeat.unref?.();
      // Restore enabled workers without waiting for a browser to reconnect.
      for (const { playerId, value } of store.list()) {
        if (
          !value?.auto?.enabled &&
          value?.businessHelper?.run?.status !== "running" &&
          value?.workFarm?.run?.status !== "running"
        )
          continue;
        const entry = await actor(playerId);
        if (value?.workFarm?.run?.status === "running") {
          entry.workFarm.resume();
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
          entry.collector.resume(value.auto, true);
          save(entry);
          continue;
        }
        if (entry.controller.getSnapshot().boss)
          await entry.controller.refresh();
        if (entry.collector.running()) {
          entry.collector.resume(
            value.auto,
            Boolean(entry.controller.getSnapshot().needsRefresh),
          );
          save(entry);
          continue;
        }
        if (
          !entry.controller.getSnapshot().needsRefresh &&
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
