import { isTerminalBossBattle } from "./boss-battle-status.js";
import { authorizeRequest } from "../../../../shared/auth-session.js";

export function createBossBattleRequest({
  authorize = authorizeRequest,
  fetcher = fetch,
} = {}) {
  return async function requestBossBattle(method, path, body, { signal } = {}) {
    if (!(
      (method === "GET" &&
        (/^\/api\/bosses\/(?:\d+|battles\/[A-Za-z0-9_-]+)$/.test(path) ||
          path === "/api/me/bag")) ||
      (method === "POST" &&
        (/^\/api\/bosses\/(?:\d+\/battles|battles\/[A-Za-z0-9_-]+\/(?:attack|items\/use))$/.test(
          path,
        ) ||
          path === "/api/me/bag/combat-items/buy"))
    ))
      throw new Error("Недопустимое действие боя");
    const authorized = authorize({ url: path });
    const response = await fetcher(authorized.url, {
      method,
      headers: {
        ...authorized.headers,
        Accept: "application/json",
        ...(method === "POST"
          ? {
              "Content-Type": "application/json",
              "X-Madhouse-Allow-Mutations": "true",
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.any([
        signal || new AbortController().signal,
        AbortSignal.timeout(20000),
      ]),
    });
    if (
      response.status === 409 &&
      method === "POST" &&
      /^\/api\/bosses\/battles\/[A-Za-z0-9_-]+\/attack$/.test(path)
    ) {
      let value;
      try {
        value = await response.json();
      } catch {
        /* An unparseable response remains uncertain. */
      }
      const expectedId = path.split("/")[4];
      if (
        value?.error === "battle_finished" &&
        value.battle?.battleId === expectedId &&
        isTerminalBossBattle(value.battle)
      )
        return { ...value, battleFinished: true };
    }
    if (!response.ok) {
      const error = new Error("Не удалось выполнить действие боя");
      error.status = response.status;
      throw error;
    }
    if (method === "POST" && path === "/api/me/bag/combat-items/buy") {
      await response.body?.cancel();
      return null;
    }
    return response.json();
  };
}
