import {
  bossBattleReference,
  grantedBattleDrops,
} from "./boss-battle-reference.js";
import {
  medicineNames,
  medicinePurchaseQuote,
  normalizeMedicines,
} from "./boss-medicines.js";

import {
  BOSS_BATTLE_OUTCOMES as outcomes,
  normalizeBossBattleStatus,
  isTerminalBossBattle,
} from "./boss-battle-status.js";

const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

// Retain only display fields. No player identifiers, credentials, balances or raw bodies.
export function normalizeBattle(
  raw,
  bossId,
  now = Date.now(),
  identity = null,
) {
  if (
    !raw ||
    typeof raw.battleId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(raw.battleId) ||
    String(raw.bossId) !== String(bossId)
  )
    throw new Error("Не удалось прочитать состояние боя.");
  const status = normalizeBossBattleStatus(raw.status);
  const serverTime = Date.parse(raw.serverTimeUtc);
  const cooldown = Date.parse(raw.cooldownUntilUtc);
  const delay = Math.max(
    number(raw.retryAfterMilliseconds) ?? 0,
    Number.isFinite(cooldown)
      ? cooldown - (Number.isFinite(serverTime) ? serverTime : now)
      : 0,
    0,
  );
  const expires = Date.parse(raw.expiresAtUtc);
  const reward = raw.reward;
  const guaranteed = reward?.guaranteed;
  const rewards = [];
  for (const [key, label] of Object.entries({
    gold: "Золото",
    dollar: "Доллары",
    pills: "Таблетки",
    exp: "Опыт",
  })) {
    if (number(guaranteed?.[key]) !== null)
      rewards.push(`${label}: ${guaranteed[key]}`);
  }
  if (Array.isArray(reward?.drops)) {
    for (const drop of reward.drops) {
      if (
        drop?.granted === true &&
        typeof drop.name === "string" &&
        number(drop.amount) !== null
      )
        rewards.push(`${drop.name}: ${drop.amount}`);
    }
  }
  // The documented actions array has no battle-wide attack total, so keep this
  // statistic unavailable instead of inferring it from a possibly partial log.
  const participants = Array.isArray(raw.participants)
    ? raw.participants.slice(0, 50).flatMap((participant) => {
        if (!participant || typeof participant !== "object") return [];
        const projected = {};
        for (const key of ["nickname", "role", "status"]) {
          if (typeof participant[key] === "string")
            projected[key] = participant[key].slice(0, 80);
        }
        for (const key of ["level", "health", "maxHealth", "damageDealt"]) {
          if (number(participant[key]) !== null)
            projected[key] = participant[key];
        }
        return [projected];
      })
    : [];
  const participantNames = new Map(
    (Array.isArray(raw.participants) ? raw.participants : [])
      .filter(
        (participant) =>
          participant &&
          (typeof participant.playerId === "number" ||
            typeof participant.playerId === "string") &&
          typeof participant.nickname === "string" &&
          participant.nickname.trim(),
      )
      .map((participant) => [
        String(participant.playerId),
        participant.nickname.slice(0, 80),
      ]),
  );
  const events = (Array.isArray(raw.actions) ? raw.actions : [])
    .slice(0, 100)
    .flatMap((action) => {
      if (!action || typeof action !== "object" || number(action.turn) === null)
        return [];
      const occurredAt = Date.parse(action.occurredAtUtc);
      return [
        {
          turn: action.turn,
          at: Number.isFinite(occurredAt) ? occurredAt : null,
          actor:
            (typeof action.playerId === "number" ||
            typeof action.playerId === "string"
              ? participantNames.get(String(action.playerId)) ||
                (identity?.playerId != null &&
                String(action.playerId) === String(identity.playerId)
                  ? identity.nickname
                  : null)
              : null) || "Участник",
          damage: number(action.playerDamage),
          critical:
            typeof action.critical === "boolean" ? action.critical : null,
          itemType:
            typeof action.itemType === "string"
              ? action.itemType.slice(0, 80)
              : null,
          healthRestored: number(action.healthRestored),
        },
      ];
    })
    .sort((a, b) => b.turn - a.turn || (b.at ?? 0) - (a.at ?? 0));
  return {
    id: raw.battleId,
    status,
    outcome: outcomes[status] || null,
    playerHealth: number(raw.playerHealth),
    playerMaxHealth: number(raw.playerMaxHealth),
    bossHealth: number(raw.bossHealth),
    bossMaxHealth: number(raw.bossMaxHealth),
    readyAt: now + delay,
    cooldownKnown:
      Number.isFinite(cooldown) || number(raw.retryAfterMilliseconds) !== null,
    expiresAt: Number.isFinite(expires)
      ? now + expires - (Number.isFinite(serverTime) ? serverTime : now)
      : null,
    rewards,
    currencyRewards: ["gold", "pills", "dollar", "exp"].flatMap((type) =>
      number(guaranteed?.[type]) !== null
        ? [{ type, amount: guaranteed[type] }]
        : [],
    ),
    grantedDrops: grantedBattleDrops(reward),
    rewardKnown: Array.isArray(reward?.drops),
    attackCount: null,
    totalDamage: number(raw.myDamage),
    dropDamageRequired: number(raw.dropDamageRequired),
    quotaFresh:
      number(raw.dropDamageRequired) !== null && number(raw.myDamage) !== null,
    maxParticipants: number(raw.maxParticipants),
    myRewardEligible:
      typeof raw.myRewardEligible === "boolean" ? raw.myRewardEligible : null,
    receivedHits: [],
    lastPlayerDamage: null,
    participantCount:
      number(raw.participantCount) ??
      (Array.isArray(raw.participants) &&
      raw.participants.length === participants.length
        ? participants.length
        : null),
    detailsLoaded:
      Array.isArray(raw.participants) &&
      raw.participants.length === participants.length,
    participantsStale: false,
    participants,
    events,
  };
}

const eventIdentity = (event) => event.localKey ?? `turn-${event.turn}`;
const sortEvents = (a, b) =>
  Number.isFinite(a.turn) && Number.isFinite(b.turn)
    ? b.turn - a.turn || (b.at ?? 0) - (a.at ?? 0)
    : (b.at ?? 0) - (a.at ?? 0);

// Mutation replies may omit lists. Keep confirmed display data until an explicit
// refresh supplies a new snapshot; do not clear the journal between strikes.
function mergeBattleReply(previous, raw, bossId, now, identity = null) {
  const next = normalizeBattle(raw, bossId, now, identity);
  if (!previous || previous.id !== next.id) return next;
  for (const key of [
    "status",
    "playerHealth",
    "playerMaxHealth",
    "bossHealth",
    "bossMaxHealth",
  ])
    if (!Object.hasOwn(raw, key)) next[key] = previous[key];
  if (!Object.hasOwn(raw, "expiresAtUtc")) next.expiresAt = previous.expiresAt;
  next.readyAt = Math.max(next.readyAt, previous.readyAt);
  if (!Object.hasOwn(raw, "myDamage")) next.totalDamage = previous.totalDamage;
  if (!Object.hasOwn(raw, "dropDamageRequired"))
    next.dropDamageRequired = previous.dropDamageRequired;
  if (!Object.hasOwn(raw, "maxParticipants"))
    next.maxParticipants = previous.maxParticipants;
  if (!Object.hasOwn(raw, "myRewardEligible"))
    next.myRewardEligible = previous.myRewardEligible;
  next.receivedHits = previous.receivedHits ?? [];
  if (number(raw.participantCount) === null)
    next.participantCount = previous.participantCount;
  if (!Array.isArray(raw.participants)) {
    next.participants = previous.participants.map((participant) => ({
      ...participant,
      damageDealt: null,
    }));
    next.participantsStale = true;
    next.detailsLoaded = previous.detailsLoaded;
  } else if (
    JSON.stringify(next.participants) === JSON.stringify(previous.participants)
  )
    next.participants = previous.participants;
  if (!Array.isArray(raw.actions)) next.events = previous.events;
  else {
    const byTurn = new Map(
      previous.events.map((event) => [eventIdentity(event), event]),
    );
    for (const event of next.events) {
      const old = byTurn.get(eventIdentity(event));
      const resolved =
        old && !Array.isArray(raw.participants) && event.actor === "Участник"
          ? { ...event, actor: old.actor }
          : event;
      byTurn.set(
        eventIdentity(event),
        old && JSON.stringify(old) === JSON.stringify(resolved)
          ? old
          : resolved,
      );
    }
    next.events = [...byTurn.values()].sort(sortEvents).slice(0, 100);
    if (
      next.events.length === previous.events.length &&
      next.events.every((event, index) => event === previous.events[index])
    )
      next.events = previous.events;
  }
  if (!Object.hasOwn(raw, "reward")) {
    next.rewards = previous.rewards;
    next.currencyRewards = previous.currencyRewards;
    next.grantedDrops = previous.grantedDrops;
    next.rewardKnown = previous.rewardKnown;
  }
  return next;
}

function battleAvailable(state, now, cooldown = true) {
  const b = state.battle;
  return Boolean(
    b &&
    b.status === "active" &&
    !state.pending &&
    !state.needsRefresh &&
    b.playerHealth > 0 &&
    b.bossHealth > 0 &&
    b.playerMaxHealth > 0 &&
    b.bossMaxHealth > 0 &&
    (!cooldown || now >= b.readyAt) &&
    (b.expiresAt === null || now < b.expiresAt),
  );
}
export function battleActionHint(state) {
  if (state.errorStatus === 401) return "Сессия игры истекла. Войдите заново.";
  if (state.errorStatus === 403) return "Игровой сервер отказал в доступе.";
  if (state.errorStatus === 429)
    return "Игровой сервер ограничил запросы. Попробуйте позже.";
  if (state.errorStatus)
    return `Игровой сервер вернул HTTP ${state.errorStatus}. Обновите состояние боя.`;
  if (state.needsRefresh)
    return "Не удалось проверить состояние боя. Нажмите «Обновить».";
  if (!state.battle && !state.canStart)
    return "Игровой сервер пока не разрешил начать бой.";
  return undefined;
}

export function canAttackBattle(state, now = Date.now()) {
  return !state.medicineOpen && battleAvailable(state, now);
}
export function canUseMedicine(state, type, now = Date.now()) {
  return Boolean(
    state.medicineOpen &&
    !state.purchase &&
    !state.purchaseUncertain &&
    Object.hasOwn(medicineNames, type) &&
    battleAvailable(state, now) &&
    state.battle.playerHealth < state.battle.playerMaxHealth &&
    state.medicines?.find((item) => item.type === type)?.quantity > 0,
  );
}
export function canShopMedicines(state, now = Date.now()) {
  return Boolean(
    state.medicineOpen &&
    !state.purchaseUncertain &&
    battleAvailable(state, now, false),
  );
}
const emptyState = () => ({
  visible: false,
  boss: null,
  battle: null,
  pending: null,
  error: null,
  errorStatus: null,
  needsRefresh: false,
  canStart: false,
  medicineOpen: false,
  medicines: null,
  purchase: null,
  purchaseUncertain: false,
  invitationOnly: false,
  pendingInvitation: null,
  notice: null,
  damageLimit: null,
});

export function createBossBattleController({
  request,
  now = Date.now,
  operationId = () => crypto.randomUUID(),
  canManualAttack = () => true,
  canStartBattle = () => true,
  canSendMutation = () => true,
  getPlayerIdentity = () => null,
}) {
  let state = emptyState();
  const listeners = new Set();
  let generation = 0;
  let controller;
  let confirmedSequence = 0;
  let playerIdentity = null;
  const hydratedBattles = new Set();
  function currentIdentity() {
    let incoming;
    try {
      incoming = getPlayerIdentity();
    } catch {
      /* Identity is display-only. */
    }
    if (typeof incoming?.nickname === "string" && incoming.nickname.trim())
      playerIdentity = {
        nickname: incoming.nickname.trim().slice(0, 80),
        playerId:
          Number.isSafeInteger(incoming.playerId) && incoming.playerId > 0
            ? incoming.playerId
            : null,
      };
    return playerIdentity;
  }
  function ownNickname() {
    return currentIdentity()?.nickname || "Игрок";
  }
  function publish(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function run(kind, task) {
    if (state.pending) return;
    const version = generation;
    controller = new AbortController();
    const signal = controller.signal;
    let sent = false;
    publish({ pending: kind, error: null, errorStatus: null, notice: null });
    const call = (method, path, body) => {
      if (generation !== version || signal.aborted)
        throw new Error("Сессия изменилась");
      if (method === "POST") {
        if (!canSendMutation())
          throw new Error("Время выполнения цели истекло.");
        sent = true;
      }
      return request(method, path, body, { signal });
    };
    try {
      return await task(call, version);
    } catch (error) {
      if (version === generation)
        publish({
          needsRefresh: true,
          canStart: false,
          errorStatus:
            Number.isInteger(error?.status) &&
            error.status >= 100 &&
            error.status <= 599
              ? error.status
              : null,
          purchase: null,
          ...(["heal", "buy"].includes(kind) ? { medicines: null } : {}),
          purchaseUncertain:
            state.purchaseUncertain || (kind === "buy" && sent),
          error:
            kind === "refresh"
              ? "Не удалось обновить состояние."
              : "Результат действия не подтверждён. Автоматического повтора не будет.",
        });
    } finally {
      if (version === generation) publish({ pending: null });
    }
  }
  function projectDamageLimit(detail, bossId) {
    if (String(detail?.id) !== String(bossId))
      throw new Error("Другой босс в ответе");
    const value = detail.damageMax;
    return Number.isSafeInteger(value) && value >= 0
      ? { bossId, value, checkedAt: now(), source: "api.damageMax" }
      : null;
  }
  async function refreshDamageLimit() {
    if (!state.boss) return;
    const bossId = state.boss.id;
    return run("refresh", async (call, version) => {
      publish({ damageLimit: null });
      const detail = await call("GET", `/api/bosses/${bossId}`);
      if (version === generation)
        publish({ damageLimit: projectDamageLimit(detail, bossId) });
    });
  }
  async function readCurrent(call, boss, battleId, withMedicines) {
    let battle;
    let canStart = false;
    let readSummary = !battleId;
    let damageLimit = state.damageLimit;
    if (battleId) {
      try {
        battle = normalizeBattle(
          await call(
            "GET",
            `/api/bosses/battles/${encodeURIComponent(battleId)}`,
          ),
          boss.id,
          now(),
          currentIdentity(),
        );
        if (battle.id !== battleId) throw new Error("Другой бой в ответе");
        battle.detailsLoaded = true;
        readSummary =
          !isTerminalBossBattle(battle) &&
          (battle.status !== "active" ||
            battle.playerHealth === 0 ||
            battle.bossHealth === 0 ||
            (battle.expiresAt != null && battle.expiresAt <= now()));
      } catch (error) {
        if (![404, 410].includes(error?.status)) throw error;
        readSummary = true;
      }
    }
    if (readSummary) {
      const detail = await call("GET", `/api/bosses/${boss.id}`);
      if (String(detail?.id) !== String(boss.id))
        throw new Error("Другой босс в ответе");
      damageLimit = projectDamageLimit(detail, boss.id);
      if (!Object.hasOwn(detail, "activeBattle"))
        throw new Error("Неполное состояние босса");
      if (detail.activeBattle) {
        battle = normalizeBattle(
          detail.activeBattle,
          boss.id,
          now(),
          currentIdentity(),
        );
        battle.detailsLoaded = false;
        canStart =
          isTerminalBossBattle(battle) && detail.state?.canStartFight === true;
      } else {
        if (detail.activeBattle !== null || !detail.state)
          throw new Error("Неполное состояние босса");
        battle = null;
        canStart = detail.state.canStartFight === true;
      }
    }
    const medicines = withMedicines
      ? normalizeMedicines(await call("GET", "/api/me/bag"))
      : state.medicines;
    return {
      battle: battle
        ? {
            ...battle,
            readyAt: Math.max(
              battle.readyAt,
              state.battle?.id === battle.id ? state.battle.readyAt : 0,
            ),
          }
        : null,
      canStart,
      medicines,
      damageLimit,
      needsRefresh: false,
    };
  }
  function projectInvitationBattle(boss, raw, invitation) {
    if (
      raw?.battleId !== invitation.battleId ||
      String(raw?.bossId) !== String(invitation.bossId)
    )
      throw new Error("Не удалось подтвердить бой по приглашению.");
    const identity = currentIdentity();
    if (
      identity?.playerId == null ||
      !Array.isArray(raw.participants) ||
      !raw.participants.some(
        (participant) =>
          participant?.playerId != null &&
          String(participant.playerId) === String(identity.playerId),
      )
    )
      throw new Error("Участие в бою по приглашению не подтверждено.");
    const battle = normalizeBattle(raw, boss.id, now(), identity);
    battle.detailsLoaded = true;
    return { battle, canStart: false, needsRefresh: false };
  }
  async function readInvitationBattle(call, boss, invitation) {
    const raw = await call(
      "GET",
      `/api/bosses/battles/${encodeURIComponent(invitation.battleId)}`,
    );
    const detail = await call("GET", `/api/bosses/${boss.id}`);
    return {
      ...projectInvitationBattle(boss, raw, invitation),
      damageLimit: projectDamageLimit(detail, boss.id),
    };
  }
  function applyCurrent(current, version, extra = {}) {
    if (version !== generation) return;
    publish({
      ...current,
      ...(state.invitationOnly ? { canStart: false } : {}),
      ...((!current.battle || current.battle.status !== "active") &&
      !(extra.purchaseUncertain ?? state.purchaseUncertain)
        ? { medicineOpen: false }
        : {}),
      ...extra,
    });
  }
  async function refresh() {
    if (!state.boss) return;
    const boss = state.boss;
    const battleId = state.battle?.id;
    return run("refresh", async (call, version) => {
      if (state.pendingInvitation) {
        const current = await readInvitationBattle(
          call,
          boss,
          state.pendingInvitation,
        );
        applyCurrent(current, version, {
          pendingInvitation: null,
          invitationOnly: true,
          canStart: false,
          purchase: null,
        });
        return;
      }
      const current = await readCurrent(
        call,
        boss,
        battleId,
        state.medicineOpen,
      );
      applyCurrent(current, version, { purchase: null });
    });
  }
  async function mutate(kind, automatic = false, beforeSend = () => true) {
    if (!state.boss || state.pending || state.needsRefresh) return;
    if (
      kind === "start"
        ? state.invitationOnly ||
          !state.canStart ||
          state.battle ||
          !canStartBattle()
        : !canAttackBattle(
            automatic ? { ...state, medicineOpen: false } : state,
            now(),
          )
    )
      return;
    const boss = state.boss;
    const battleId = state.battle?.id;
    return run(kind, async (call, version) => {
      publish({ canStart: false, needsRefresh: true });
      const path =
        kind === "start"
          ? `/api/bosses/${boss.id}/battles`
          : `/api/bosses/battles/${encodeURIComponent(battleId)}/attack`;
      const actionId = operationId();
      if (!beforeSend({ operationId: actionId })) return;
      const response = await call("POST", path, { operationId: actionId });
      if (version !== generation) return;
      const previous = state.battle;
      const battle = mergeBattleReply(
        previous,
        response?.battle,
        boss.id,
        now(),
        currentIdentity(),
      );
      if (battleId && battle.id !== battleId)
        throw new Error("Другой бой в ответе");
      if (kind === "attack") {
        if (response?.battleFinished === true && isTerminalBossBattle(battle)) {
          applyCurrent(
            { battle, canStart: false, needsRefresh: false },
            version,
          );
          return;
        }
        // A confirmed strike already returns state. Never fetch the whole fight
        // again here; incomplete replies require an explicit user refresh.
        const complete =
          typeof response.battle.status === "string" &&
          number(response.battle.playerHealth) !== null &&
          number(response.battle.bossHealth) !== null &&
          response.isDuplicate !== true;
        battle.receivedHits = (
          Array.isArray(response.hits) ? response.hits : []
        )
          .filter((hit) => hit?.actor === "boss" && number(hit.damage) !== null)
          .map((hit) => ({
            damage: hit.damage,
            critical: hit.critical === true,
            targetHealth: number(hit.targetHealth),
          }));
        const playerHits = Array.isArray(response.hits)
          ? response.hits.filter(
              (hit) =>
                typeof hit?.actor === "string" &&
                hit.actor.toLowerCase() === "player" &&
                number(hit.damage) !== null,
            )
          : [];
        battle.lastPlayerDamage =
          playerHits.length && !playerHits.some((hit) => hit.critical === true)
            ? playerHits.reduce((sum, hit) => sum + hit.damage, 0)
            : null;
        const damage = playerHits.length
          ? playerHits.reduce((sum, hit) => sum + hit.damage, 0)
          : null;
        if (
          complete &&
          !Object.hasOwn(response.battle, "myDamage") &&
          damage !== null &&
          previous?.totalDamage != null
        )
          battle.totalDamage = previous.totalDamage + damage;
        if (complete && previous && battle.events === previous.events) {
          const turn =
            Number.isSafeInteger(response.battle.turn) &&
            response.battle.turn >= 0
              ? response.battle.turn
              : null;
          const event = {
            turn,
            at: now(),
            actor: ownNickname(),
            damage,
            critical: playerHits.some((hit) => hit.critical === true),
            itemType: null,
            healthRestored: null,
            confirmed: true,
            ...(turn === null ||
            battle.events.some((entry) => entry.turn === turn)
              ? { localKey: `confirmed-${++confirmedSequence}` }
              : {}),
          };
          const events = new Map(
            battle.events.map((entry) => [eventIdentity(entry), entry]),
          );
          events.set(eventIdentity(event), event);
          battle.events = [...events.values()].sort(sortEvents).slice(0, 100);
        }
        applyCurrent(
          {
            battle,
            canStart: false,
            needsRefresh: !complete,
          },
          version,
        );
      } else {
        publish({ battle });
        applyCurrent(await readCurrent(call, boss, battle.id, false), version);
      }
    });
  }
  async function startNextBattle({
    allowed = () => true,
    beforeSend = () => true,
  } = {}) {
    if (
      !state.boss ||
      state.invitationOnly ||
      !isTerminalBossBattle(state.battle) ||
      !canStartBattle() ||
      !allowed() ||
      state.pending ||
      state.needsRefresh ||
      state.purchaseUncertain ||
      state.purchase
    )
      return;
    const boss = state.boss;
    const finishedId = state.battle.id;
    return run("restart", async (call, version) => {
      // A fresh preflight prevents a second start if a fight was opened elsewhere.
      const current = await readCurrent(call, boss, null, false);
      if (version !== generation) return;
      if (current.battle?.status === "active") {
        applyCurrent(current, version, { medicineOpen: false, purchase: null });
        return;
      }
      if (
        !current.canStart ||
        (current.battle && !isTerminalBossBattle(current.battle))
      ) {
        publish({ notice: "Сейчас напасть снова нельзя. Попробуйте позже." });
        return;
      }
      publish({ damageLimit: current.damageLimit });
      // A goal can be stopped while the read-only preflight is in flight.
      if (!canStartBattle() || !allowed()) return;
      // Once the user starts the next attempt, manual refresh must discover its
      // ID even if the POST response is lost. Never retry the POST automatically.
      publish({
        battle: null,
        canStart: false,
        needsRefresh: true,
        medicineOpen: false,
        purchase: null,
      });
      const actionId = operationId();
      if (!beforeSend({ operationId: actionId })) return;
      const response = await call("POST", `/api/bosses/${boss.id}/battles`, {
        operationId: actionId,
      });
      if (version !== generation) return;
      const battle = normalizeBattle(
        response?.battle,
        boss.id,
        now(),
        currentIdentity(),
      );
      if (battle.id === finishedId)
        throw new Error("Сервер вернул завершённый бой");
      publish({ battle });
      applyCurrent(await readCurrent(call, boss, battle.id, false), version);
    });
  }
  async function useMedicine(
    type,
    { automatic = false, allowed = () => true } = {},
  ) {
    const eligible = (current) =>
      canUseMedicine(
        automatic ? { ...current, medicineOpen: true } : current,
        type,
        now(),
      );
    if (!eligible(state)) return;
    const boss = state.boss;
    const battleId = state.battle.id;
    return run("heal", async (call, version) => {
      const before = await readCurrent(call, boss, battleId, true);
      if (version !== generation) return;
      if (
        before.battle?.id !== battleId ||
        !eligible({ ...state, ...before, pending: null })
      ) {
        applyCurrent(before, version, {
          purchase: null,
          notice: "Лечение сейчас недоступно. Состояние обновлено.",
        });
        return;
      }
      const actionId = operationId();
      if (!allowed({ operationId: actionId }, before)) return;
      publish({ ...before, needsRefresh: true, purchase: null });
      const response = await call(
        "POST",
        `/api/bosses/battles/${encodeURIComponent(battleId)}/items/use`,
        { type, operationId: actionId },
      );
      if (version !== generation) return;
      const battle = normalizeBattle(
        response?.battle,
        boss.id,
        now(),
        currentIdentity(),
      );
      if (battle.id !== battleId) throw new Error("Другой бой в ответе");
      publish({ battle });
      const after = await readCurrent(call, boss, battleId, true);
      const previousQuantity = before.medicines.find(
        (m) => m.type === type,
      ).quantity;
      const quantity = after.medicines?.find((m) => m.type === type)?.quantity;
      const receipt = response?.itemResult;
      const confirmed = automatic
        ? response.isDuplicate !== true &&
          receipt?.type === type &&
          receipt.quantity === previousQuantity - 1 &&
          receipt.healthRestored > 0 &&
          quantity === previousQuantity - 1 &&
          after.battle?.id === battleId &&
          after.battle.playerHealth > before.battle.playerHealth
        : (quantity !== null &&
            quantity !== undefined &&
            quantity < previousQuantity) ||
          (after.battle?.id === battleId &&
            after.battle.playerHealth > before.battle.playerHealth);
      applyCurrent(after, version, {
        needsRefresh: !confirmed,
        notice: confirmed
          ? "Здоровье и запас аптечек обновлены."
          : "Использование аптечки не подтверждено. Обновите состояние.",
      });
      return { confirmed };
    });
  }
  async function buyMedicine({
    automatic = false,
    quote = state.purchase,
    allowed = () => true,
  } = {}) {
    const eligible = (current) =>
      canShopMedicines(
        automatic ? { ...current, medicineOpen: true } : current,
        now(),
      );
    if (!quote || !eligible(state)) return;
    const boss = state.boss;
    const battleId = state.battle.id;
    return run("buy", async (call, version) => {
      const before = await readCurrent(call, boss, battleId, true);
      if (version !== generation) return;
      const freshQuote = medicinePurchaseQuote(
        before.medicines,
        quote.type,
        quote.currency,
        quote.quantity,
      );
      if (
        before.battle?.id !== battleId ||
        !eligible({ ...state, ...before, pending: null }) ||
        !freshQuote ||
        freshQuote.unitPrice !== quote.unitPrice
      ) {
        applyCurrent(before, version, {
          purchase: null,
          notice:
            "Условия покупки изменились. Проверьте цену и подтвердите заново.",
        });
        return;
      }
      const walletBefore = automatic
        ? (await call("GET", "/api/me"))?.wallet?.[quote.currency]
        : null;
      if (
        automatic &&
        (!Number.isSafeInteger(walletBefore) || walletBefore < freshQuote.total)
      ) {
        applyCurrent(before, version, {
          notice: "Не удалось подтвердить достаточный баланс для покупки.",
          purchase: null,
        });
        return;
      }
      const actionId = operationId();
      if (!allowed(freshQuote, { operationId: actionId }, before)) return;
      publish({ ...before, needsRefresh: true, purchase: null });
      // The successful purchase body is undocumented; verify stock using GET.
      await call("POST", "/api/me/bag/combat-items/buy", {
        type: quote.type,
        currency: quote.currency,
        quantity: quote.quantity,
        operationId: actionId,
      });
      const after = await readCurrent(call, boss, battleId, true);
      const previousQuantity = before.medicines.find(
        (m) => m.type === quote.type,
      ).quantity;
      const quantity = after.medicines?.find(
        (m) => m.type === quote.type,
      )?.quantity;
      const walletAfter = automatic
        ? (await call("GET", "/api/me"))?.wallet?.[quote.currency]
        : null;
      const confirmed =
        Number.isSafeInteger(quantity) &&
        quantity === previousQuantity + quote.quantity &&
        (!automatic || walletAfter === walletBefore - quote.total);
      applyCurrent(after, version, {
        purchaseUncertain: !confirmed,
        notice: confirmed
          ? "Покупка подтверждена. Аптечки добавлены в запас."
          : "Покупка не подтверждена. Проверьте запас; не повторяйте её автоматически.",
      });
      return { confirmed };
    });
  }
  return {
    getSnapshot: () => state,
    // Trusted server persistence only; never accept this shape from an API caller.
    restoreState(saved) {
      if (state.boss || !saved?.boss) return;
      publish({
        ...emptyState(),
        ...saved,
        battle: saved.battle
          ? {
              ...saved.battle,
              status: normalizeBossBattleStatus(saved.battle.status),
              outcome:
                outcomes[normalizeBossBattleStatus(saved.battle.status)] ||
                null,
            }
          : null,
        visible: false,
        damageLimit: null,
        pending: null,
        canStart: false,
        needsRefresh: true,
        purchase: null,
        purchaseUncertain: Boolean(
          saved.purchaseUncertain || saved.pending === "buy",
        ),
        notice: saved.pending
          ? "Предыдущее действие не подтверждено. Обновите состояние; автоматического повтора не будет."
          : saved.notice,
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async open(boss, { refresh: shouldRefresh = true } = {}) {
      const id = Number(boss.numericId ?? boss.apiId);
      if (!Number.isSafeInteger(id) || id <= 0) return;
      if (
        !shouldRefresh &&
        state.boss &&
        state.battle?.status === "active" &&
        !state.needsRefresh &&
        !state.purchaseUncertain
      ) {
        publish({ visible: true });
        return;
      }
      if (
        state.boss &&
        (state.pending ||
          state.needsRefresh ||
          state.purchaseUncertain ||
          (state.battle && !state.battle.outcome))
      ) {
        publish({ visible: true, needsRefresh: true });
        const version = generation;
        await refresh();
        if (
          version !== generation ||
          !state.visible ||
          state.pending ||
          state.needsRefresh ||
          state.purchaseUncertain ||
          state.error ||
          (state.battle && !isTerminalBossBattle(state.battle)) ||
          state.boss?.id === id
        )
          return;
      }
      if (state.boss?.id !== id)
        publish({
          ...emptyState(),
          boss: { id, name: boss.name, reference: bossBattleReference(boss) },
        });
      publish({ visible: true });
      return refresh();
    },
    syncExternalBattle(boss, raw, expectedSnapshot) {
      if (
        state !== expectedSnapshot ||
        state.pending ||
        state.purchase ||
        state.medicineOpen
      )
        return false;
      const id = Number(boss.numericId ?? boss.apiId);
      if (state.purchaseUncertain && state.boss?.id !== id) return false;
      const battle = normalizeBattle(raw, id, now(), currentIdentity());
      if (battle.status !== "active" && state.battle?.id !== battle.id)
        return false;
      const same = state.boss?.id === id;
      publish({
        ...(same ? {} : emptyState()),
        visible: state.visible,
        boss: same
          ? state.boss
          : { id, name: boss.name, reference: bossBattleReference(boss) },
        battle,
        canStart: false,
        needsRefresh: state.purchaseUncertain ? state.needsRefresh : false,
        error: null,
        errorStatus: null,
      });
      return true;
    },
    close: () => publish({ visible: false }),
    refresh,
    refreshDamageLimit,
    async acceptInvitation(
      boss,
      { invitationId, battleId, bossId, expiresAt } = {},
    ) {
      const id = Number(boss?.numericId ?? boss?.apiId ?? boss?.id);
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        String(bossId) !== String(id) ||
        !/^[A-Za-z0-9_-]+$/.test(String(invitationId || "")) ||
        !/^[A-Za-z0-9_-]+$/.test(String(battleId || "")) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now() ||
        state.battle?.status === "active" ||
        state.pending ||
        state.needsRefresh ||
        state.purchaseUncertain ||
        state.purchase ||
        state.medicineOpen
      )
        return false;
      const selectedBoss = {
        id,
        name: boss.name,
        reference: bossBattleReference(boss),
      };
      const invitation = { invitationId, battleId, bossId: id, expiresAt };
      return run("accept", async (call, version) => {
        publish({
          boss: selectedBoss,
          battle: null,
          canStart: false,
          invitationOnly: true,
          pendingInvitation: invitation,
          needsRefresh: true,
          medicineOpen: false,
          purchase: null,
        });
        await call(
          "POST",
          `/api/bosses/invitations/${encodeURIComponent(invitationId)}/accept`,
          { operationId: operationId() },
        );
        if (version !== generation) return;
        const current = await readInvitationBattle(
          call,
          selectedBoss,
          invitation,
        );
        applyCurrent(current, version, {
          pendingInvitation: null,
          invitationOnly: true,
          canStart: false,
          purchase: null,
          notice: "Приглашение принято. Подтверждено участие в бою.",
        });
      });
    },
    adoptJoinedInvitation(boss, raw) {
      const id = Number(boss?.numericId ?? boss?.apiId ?? boss?.id);
      const invitation = {
        battleId: raw?.battleId,
        bossId: id,
      };
      if (
        !Number.isSafeInteger(id) ||
        id <= 0 ||
        state.pending ||
        state.purchaseUncertain ||
        state.purchase ||
        state.medicineOpen ||
        (state.battle?.status === "active" &&
          state.battle.id !== invitation.battleId)
      )
        return false;
      let current;
      try {
        current = projectInvitationBattle({ ...boss, id }, raw, invitation);
      } catch {
        return false;
      }
      publish({
        boss: {
          id,
          name: boss.name,
          reference: bossBattleReference(boss),
        },
        ...current,
        canStart: false,
        invitationOnly: true,
        pendingInvitation: null,
        needsRefresh: false,
        error: null,
        errorStatus: null,
        purchase: null,
        notice: "Участие в бою по приглашению подтверждено.",
      });
      return true;
    },
    clearExpiredInvitation() {
      const invitation = state.pendingInvitation;
      if (
        !invitation ||
        state.pending ||
        !Number.isFinite(invitation.expiresAt) ||
        invitation.expiresAt > now()
      )
        return false;
      publish({
        battle: null,
        canStart: false,
        pendingInvitation: null,
        invitationOnly: true,
        needsRefresh: false,
        error: null,
        errorStatus: null,
        purchase: null,
        notice: null,
      });
      return true;
    },
    hydrateDetails() {
      const id = state.battle?.id;
      if (
        !id ||
        state.pending ||
        state.battle.detailsLoaded ||
        hydratedBattles.has(id)
      )
        return;
      hydratedBattles.add(id);
      return refresh();
    },
    start: ({ beforeSend } = {}) => mutate("start", false, beforeSend),
    startNextBattle,
    attack: ({ automatic = false, beforeSend } = {}) => {
      if (!automatic && !canManualAttack()) return;
      return mutate("attack", automatic, beforeSend);
    },
    openMedicines() {
      if (
        state.pending ||
        !state.battle ||
        (state.battle.status !== "active" && !state.purchaseUncertain)
      )
        return;
      publish({ medicineOpen: true, purchase: null });
      return refresh();
    },
    closeMedicines() {
      if (!state.pending) publish({ medicineOpen: false, purchase: null });
    },
    useMedicine,
    loadMedicines() {
      if (!state.boss || !state.battle) return;
      return run("stock", async (call, version) => {
        applyCurrent(
          await readCurrent(call, state.boss, state.battle.id, true),
          version,
        );
      });
    },
    async inviteAll({ allowed = () => true, beforeSend = () => {} } = {}) {
      if (!battleAvailable(state, now(), false) || !allowed()) return;
      const id = state.battle.id;
      return run("invite", async (call) => {
        if (!allowed()) return;
        try {
          const actionId = operationId();
          beforeSend({ operationId: actionId });
          const reply = await call(
            "POST",
            `/api/bosses/battles/${encodeURIComponent(id)}/invitations/bulk`,
            { operationId: actionId, onlyAvailable: true, onlyOnline: true },
          );
          if (
            !Number.isSafeInteger(reply?.invitedCount) ||
            reply.invitedCount < 0
          )
            throw new Error("invalid_invitation_result");
          return {
            known: true,
            invitedCount: reply.invitedCount,
            retryAfterSeconds: reply.retryAfterSeconds,
          };
        } catch (error) {
          if (error.status === 403 || error.status === 429)
            return {
              known: true,
              forbidden: error.status === 403,
              rateLimited: error.status === 429,
              retryAfterSeconds: error.retryAfterSeconds,
            };
          throw error;
        }
      });
    },
    preparePurchase(type, currency, quantity) {
      if (!canShopMedicines(state, now())) return;
      const purchase = medicinePurchaseQuote(
        state.medicines,
        type,
        currency,
        quantity,
      );
      if (purchase) publish({ purchase, notice: null });
    },
    cancelPurchase() {
      if (!state.pending) publish({ purchase: null });
    },
    buyMedicine,
    acknowledgePurchase() {
      if (!state.pending && !state.needsRefresh && state.medicines)
        publish({
          purchaseUncertain: false,
          notice: "Повторная покупка автоматически не выполняется.",
        });
    },
    reset() {
      hydratedBattles.clear();
      playerIdentity = null;
      generation++;
      controller?.abort();
      publish(emptyState());
    },
  };
}
