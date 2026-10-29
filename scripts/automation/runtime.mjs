import { createBossCardsHttp } from "../account/boss-cards.mjs";
import { createPlayerProgressReader } from "../account/player-progress.mjs";
import { createProfileLevelHandler } from "../account/profile-level.mjs";
import { createAccountSnapshots } from "../account/snapshots.mjs";
import { createProxy, isGameApiPath } from "../../api/[...path].js";
import { resolve } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";
import { createAutomationHttp, nodeAutomationHandler } from "./http.mjs";
import { readKnowledgeBase } from "../catalogue/query.mjs";
import { isAllowedBridgeQueueCommand } from "../bridge/queue-command.mjs";
import {
  createWikiSessionAuthority,
  isWikiSessionCredential,
} from "../../shared/wiki-session.js";
import { createBlobSessionStore } from "../../connector/blob-session-store.js";

export function globalRaidsDestination(value) {
  return typeof value === "string" &&
    (/^-\d{1,16}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value))
    ? value
    : null;
}

export async function createAutomationRuntime({
  root = process.cwd(),
  env = process.env,
  bridge = null,
  wikiSessionAuthority = null,
  gameFetcher,
} = {}) {
  const enabled = env.MADHOUSE_AUTOMATION_GAME_ENABLED !== "0";
  const store = createAutomationStateStore({
    directory:
      env.MADHOUSE_AUTOMATION_STATE_DIR ||
      resolve(root, "local-data/automation"),
  });
  const snapshots = createAccountSnapshots({
    store,
    ...(gameFetcher ? { fetcher: gameFetcher } : {}),
  });
  // Bridge admission is injected only after the host has satisfied all gates.
  const transport = bridge ? bridge.wrapSnapshots(snapshots) : snapshots;
  const wikiAuthority =
    wikiSessionAuthority ||
    (env.WIKI_SESSION_KEY && env.ACCOUNT_SESSION_KEY
      ? createWikiSessionAuthority({
          store: createBlobSessionStore(),
          encryptionKey: env.ACCOUNT_SESSION_KEY,
          signingKey: env.WIKI_SESSION_KEY,
        })
      : null);
  const readPlayerProgress = bridge
    ? createPlayerProgressReader({ fetcher: transport.fetch })
    : createPlayerProgressReader({ fetcher: gameFetcher || fetch });
  const profileLevel = createProfileLevelHandler({
    identity: bridge
      ? async (authorization) => {
          const route = await transport.verifyLocal(authorization);
          if (route.policy === "bridge_required")
            return (await service.identify(authorization)).player;
          return snapshots.identity(authorization);
        }
      : snapshots.identity,
    readProgress: readPlayerProgress,
    origin: env.WIKI_PUBLIC_ORIGIN,
  });
  const proxy = createProxy(transport.fetch, {
    denyGameCredential: isWikiSessionCredential,
    storedFetch: async (url, init) => {
      const authorization = new Headers(init.headers).get("authorization");
      let verified = null;
      if (authorization?.startsWith("Bearer ") && wikiAuthority) {
        try {
          verified = await wikiAuthority.verify(authorization.slice(7));
        } catch {
          throw Object.assign(new Error("wiki_session_store_unavailable"), {
            status: 503,
          });
        }
      }
      if (verified?.legacyAuthorization) {
        const playerId = snapshots.resolveStoredOwner(
          verified.legacyAuthorization,
          verified.telegramUserId,
        );
        if (!playerId)
          return new Response(
            JSON.stringify({ error: "snapshot_unavailable" }),
            {
              status: 404,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "private, no-store",
              },
            },
          );
        verified = { ...verified, playerId };
      }
      if (verified && bridge) {
        const owner = bridge.ownerForPlayer(String(verified.playerId));
        if (owner && owner !== verified.telegramUserId)
          return new Response(null, {
            status: 401,
            headers: { "Cache-Control": "private, no-store" },
          });
      }
      if (verified)
        return snapshots.readStored(url, init, {
          verifiedWiki: true,
          verifiedPlayerId: verified.playerId,
        });
      return transport.readStored(url, init);
    },
  });
  let catalogue;
  const getCatalogue = () => (catalogue ??= readKnowledgeBase(root));
  const telegram = env.TELEGRAM_BOT_TOKEN
    ? {
        ownerForPlayer: (playerId) => bridge?.ownerForPlayer(playerId) ?? null,
        online: async (owner) =>
          bridge ? (await bridge.botDevices.status(owner)) === "online" : null,
        async request(method, payload) {
          const response = await fetch(
            `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(10000),
            },
          );
          const data = await response.json().catch(() => null);
          if (!response.ok || data?.ok !== true) {
            if (
              method === "editMessageText" &&
              response.status === 400 &&
              typeof data?.description === "string" &&
              data.description.toLowerCase().includes("message is not modified")
            )
              return true;
            const error = new Error("telegram_notification_unavailable");
            error.status = response.status;
            if (
              method === "editMessageText" &&
              response.status === 400 &&
              typeof data?.description === "string" &&
              data.description
                .toLowerCase()
                .includes("message to edit not found")
            )
              error.code = "message_missing";
            if (Number.isFinite(data?.parameters?.retry_after))
              error.retryAfterMs = Math.max(
                0,
                data.parameters.retry_after * 1000,
              );
            throw error;
          }
          return data.result;
        },
      }
    : null;
  const service = createAutomationService({
    store,
    fetcher: transport.liveFetch,
    snapshotFetch: transport.fetch,
    ...(bridge ? { queueActionGate: bridge.queueActionGate } : {}),
    ...(bridge ? { canonicalCredential: bridge.canonicalCredential } : {}),
    accountHealth: snapshots.health,
    identifyPlayer: async (authorization) => {
      const response = await transport.fetch(
        "https://cargohustle.online/api/me",
        {
          headers: {
            Authorization: authorization,
            "X-Madhouse-Snapshot-Only": "1",
          },
        },
      );
      if (!response.ok) {
        const error = new Error("game_identity_unavailable");
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
    getBoss: (id) => {
      return (
        getCatalogue().bosses.find(
          (boss) => Number(boss.numericId ?? boss.apiId) === id,
        ) || {
          numericId: id,
          name: `Босс №${id}`,
        }
      );
    },
    getBusinessCatalogue: getCatalogue,
    telegram,
    globalRaidsChatId: globalRaidsDestination(
      env.MADHOUSE_GLOBAL_RAIDS_CHAT_ID,
    ),
    telegramSiteUrl: env.WIKI_PUBLIC_ORIGIN || "https://madhouse-wiki.ru",
  });
  // Normal runtime serves authenticated commands. Explicit 0 is an operator kill switch.
  if (enabled) await service.boot();
  const automationHandle = createAutomationHttp({
    service,
    enabled,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const bossCardsHandle = createBossCardsHttp({
    identify: service.readStored,
    snapshots,
    ...(bridge ? { canonicalCredential: bridge.canonicalCredential } : {}),
    getCatalogue,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const handle = async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname.startsWith("/api/automation/") &&
      isWikiSessionCredential(request.headers.get("authorization"))
    ) {
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      };
      const failure = (status, error) =>
        new Response(JSON.stringify({ error }), { status, headers });
      if (!enabled) return failure(503, "automation_game_requests_disabled");
      if (url.pathname !== "/api/automation/state" || request.method !== "GET")
        return failure(401, "game_connection_required");
      if (
        url.search ||
        (request.headers.get("origin") &&
          request.headers.get("origin") !==
            (env.WIKI_PUBLIC_ORIGIN || url.origin))
      )
        return failure(403, "origin_rejected");
      try {
        const authorization = request.headers.get("authorization");
        const verified = await wikiAuthority?.verify(authorization.slice(7));
        if (!verified) return failure(401, "game_session_required");
        const playerId =
          verified.playerId ||
          (verified.legacyAuthorization &&
            snapshots.resolveStoredOwner(
              verified.legacyAuthorization,
              verified.telegramUserId,
            ));
        if (!playerId) return failure(404, "automation_state_unknown");
        const owner = bridge?.ownerForPlayer(String(playerId));
        if (owner && owner !== verified.telegramUserId)
          return failure(401, "game_session_required");
        return new Response(
          JSON.stringify(
            service.snapshot(await service.readStoredPlayer(playerId)),
          ),
          { headers },
        );
      } catch (error) {
        return failure(
          Number.isInteger(error?.status) ? error.status : 503,
          error?.code || "automation_unavailable",
        );
      }
    }
    if (bridge && url.pathname.startsWith("/api/automation/")) {
      let route;
      try {
        route = await transport.verifyLocal(
          request.headers.get("authorization"),
        );
      } catch {
        return new Response(null, {
          status: 401,
          headers: { "Cache-Control": "private, no-store" },
        });
      }
      if (
        route.policy === "bridge_required" &&
        request.method !== "GET" &&
        !(await isAllowedBridgeQueueCommand(request))
      )
        return new Response(
          JSON.stringify({ error: "bridge_actions_disabled" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store",
            },
          },
        );
    }
    if (url.pathname === "/api/automation/profile-level")
      return profileLevel(request);
    if (url.pathname === "/api/automation/profile-identity") {
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      };
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers });
      if (
        url.search ||
        (request.headers.get("origin") &&
          request.headers.get("origin") !==
            (env.WIKI_PUBLIC_ORIGIN || url.origin))
      )
        return new Response(null, { status: 403, headers });
      const authorization = request.headers.get("authorization");
      let identity;
      try {
        const route = bridge
          ? await transport.verifyLocal(authorization)
          : null;
        identity =
          route?.policy === "bridge_required"
            ? (await service.readStored(authorization)).player
            : snapshots.identity(authorization);
      } catch {
        identity = null;
      }
      return identity
        ? new Response(JSON.stringify(identity), { headers })
        : new Response(null, { status: 404, headers });
    }
    if (url.pathname === "/api/automation/inventory-snapshots") {
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      };
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers });
      if (
        url.search ||
        (request.headers.get("origin") &&
          request.headers.get("origin") !==
            (env.WIKI_PUBLIC_ORIGIN || url.origin))
      )
        return new Response(null, { status: 403, headers });
      const authorization = request.headers.get("authorization");
      try {
        await service.readStored(authorization);
        return new Response(
          JSON.stringify(
            snapshots.inventory(
              bridge
                ? bridge.canonicalCredential(authorization)
                : authorization,
            ),
          ),
          { headers },
        );
      } catch (error) {
        return new Response(null, {
          status: Number.isInteger(error.status) ? error.status : 401,
          headers,
        });
      }
    }
    return url.pathname === "/api/automation/bosses"
      ? bossCardsHandle(request)
      : automationHandle(request);
  };
  return {
    handle,
    proxy,
    gameFetch: transport.fetch,
    bridgeActive: Boolean(bridge),
    updateCatalogue(model) {
      catalogue = model;
    },
    async enableTelegramReport(owner, action = "enable") {
      if (!enabled || !bridge || !telegram) return false;
      const playerId = bridge.botDevices.player(owner);
      if (!playerId) return false;
      return service.enableTelegramReport(playerId, owner, action);
    },
    nodeHandler: nodeAutomationHandler(handle, {
      origin: env.WIKI_PUBLIC_ORIGIN,
    }),
    close() {
      service.close();
      store.close();
    },
  };
}

export function automationPlugin(root) {
  return {
    name: "server-owned-automations",
    async configureServer(server) {
      const runtime = await createAutomationRuntime({ root });
      server.middlewares.use((request, response, next) => {
        if (
          !/^\/api\/automation(?:\/|$)/.test(request.url?.split("?")[0] || "")
        )
          return isGameApiPath(request.url?.split("?")[0] || "")
            ? runtime.proxy(request, response)
            : next();
        return runtime.nodeHandler(request, response);
      });
      server.httpServer?.once("close", () => runtime.close());
    },
  };
}
