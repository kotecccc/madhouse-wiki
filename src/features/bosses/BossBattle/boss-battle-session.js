import { reportGameHealth } from "../../../../shared/session-api.js";
import {
  authorizeRequest,
  readSession,
} from "../../../../shared/auth-session.js";
import { createRemoteBattleSession } from "./boss-battle-remote.js";
export { createBossBattleRequest } from "./boss-battle-request.js";

async function automationRequest(method, path, body) {
  const authorized = authorizeRequest({ url: path });
  const response = await fetch(authorized.url, {
    method,
    headers: {
      ...authorized.headers,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  const value = await response.json();
  if (value.gameHealth) reportGameHealth(value.gameHealth);
  if (!response.ok) {
    const error = new Error(
      value.error === "game_unavailable_actions_paused"
        ? "Игра временно недоступна. Игровые действия приостановлены; справочник и сохранённые данные доступны для чтения."
        : value.error === "automation_game_requests_disabled"
          ? "Игровые запросы серверной автоматизации пока отключены в DEV."
          : response.status === 409
            ? "Состояние изменилось. Проверьте данные и повторите действие вручную."
            : "Не удалось получить серверное состояние боя.",
    );
    error.status = response.status;
    error.snapshot = value.snapshot;
    throw error;
  }
  return value;
}

const remote =
  import.meta.hot?.data.remote ??
  createRemoteBattleSession({
    request: automationRequest,
    launchBattle: () => readSession().activeBossBattle,
  });
export const {
  bossBattle,
  bossInvitations,
  raidSubscriptions,
  bossBattleAuto,
  bossBattleGoal,
  pvpBattle,
  workFarm,
} = remote;
export const automationPreferences = remote.preferences;
export const businessAssistant = remote.businessAssistant;
export const floorAutomation = remote.floorAutomation;
export const characterUpgrade = remote.characterUpgrade;
export const connectBattleSession = remote.connect;
export const disconnectBattleSession = remote.disconnect;
if (import.meta.hot) {
  import.meta.hot.dispose((data) => {
    data.remote = remote;
  });
}
