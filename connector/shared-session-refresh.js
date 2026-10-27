import { normalizeActiveBossBattle } from "../shared/active-boss-battle.js";

const ROUTE_BLOCKING_ERRORS = new Set([
  "bridge_auth_required",
  "bridge_route_unavailable",
  "invalid_wiki_identity",
  "try_later",
]);

function levelProgressFields(value) {
  if (
    !Number.isSafeInteger(value?.playerLevel) ||
    value.playerLevel < 1 ||
    !Number.isSafeInteger(value?.currentExp) ||
    value.currentExp < 0 ||
    !Number.isSafeInteger(value?.expToNextLevel) ||
    value.expToNextLevel < 1
  )
    return {};
  return {
    playerLevel: value.playerLevel,
    currentExp: value.currentExp,
    expToNextLevel: value.expToNextLevel,
  };
}

export async function silentlyRefreshSharedSessionData(gameLogin) {
  try {
    const result = await gameLogin();
    if (result?.status !== "connected") return null;
    return {
      ...levelProgressFields(result),
      activeBossBattle: normalizeActiveBossBattle(result.activeBossBattle),
    };
  } catch (error) {
    if (ROUTE_BLOCKING_ERRORS.has(error?.message || error?.code)) throw error;
    return null;
  }
}

export async function silentlyRefreshActiveBossBattle(gameLogin) {
  const result = await silentlyRefreshSharedSessionData(gameLogin);
  return result?.activeBossBattle ?? null;
}
