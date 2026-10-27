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
          path === "/api/me/bag" ||
          path === "/api/me")) ||
      (method === "POST" &&
        (/^\/api\/bosses\/(?:\d+\/battles|battles\/[A-Za-z0-9_-]+\/(?:attack|items\/use|invitations\/bulk))$/.test(
          path,
        ) ||
          /^\/api\/bosses\/invitations\/[A-Za-z0-9_-]+\/accept$/.test(path) ||
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
    const isBossAttack =
      method === "POST" &&
      /^\/api\/bosses\/battles\/[A-Za-z0-9_-]+\/attack$/.test(path);
    if (response.status === 409 && isBossAttack) {
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
    if (!response.ok || (isBossAttack && response.status !== 200)) {
      if (isBossAttack && response.status >= 200 && response.status < 300) {
        await response.body?.cancel().catch(() => {});
      }
      const error = new Error("Не удалось выполнить действие боя");
      error.status = response.status;
      if (path.endsWith("/invitations/bulk")) {
        let value;
        try {
          value = await response.json();
        } catch {
          /* Keep an unknown cooldown conservative. */
        }
        const seconds = Number(
          value?.retryAfterSeconds ?? response.headers.get("Retry-After"),
        );
        error.retryAfterSeconds =
          Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
      }
      throw error;
    }
    if (
      method === "POST" &&
      (path === "/api/me/bag/combat-items/buy" ||
        /^\/api\/bosses\/invitations\/[A-Za-z0-9_-]+\/accept$/.test(path))
    ) {
      await response.body?.cancel();
      return null;
    }
    return response.json();
  };
}
