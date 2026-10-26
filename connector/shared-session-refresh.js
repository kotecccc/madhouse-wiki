import { normalizeActiveBossBattle } from "../shared/active-boss-battle.js";

export async function silentlyRefreshActiveBossBattle(gameLogin) {
  try {
    const result = await gameLogin();
    if (result?.status !== "connected") return null;
    return normalizeActiveBossBattle(result.activeBossBattle);
  } catch {
    return null;
  }
}
