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

export async function createAutomationRuntime({
  root = process.cwd(),
  env = process.env,
  bridge = null,
} = {}) {
  const enabled = env.MADHOUSE_AUTOMATION_GAME_ENABLED !== "0";
  const store = createAutomationStateStore({
    directory:
      env.MADHOUSE_AUTOMATION_STATE_DIR ||
      resolve(root, "local-data/automation"),
  });
  const snapshots = createAccountSnapshots({ store });
  // Bridge admission is injected only after the host has satisfied all gates.
  const transport = bridge ? bridge.wrapSnapshots(snapshots) : snapshots;
  const readPlayerProgress = bridge
    ? createPlayerProgressReader({ fetcher: transport.fetch })
    : createPlayerProgressReader();
  const profileLevel = createProfileLevelHandler({
    identity: snapshots.identity,
    readProgress: readPlayerProgress,
    origin: env.WIKI_PUBLIC_ORIGIN,
  });
  const proxy = createProxy(transport.fetch);
  let catalogue;
  const getCatalogue = () => (catalogue ??= readKnowledgeBase(root));
  const service = createAutomationService({
    store,
    fetcher: transport.liveFetch,
    snapshotFetch: transport.fetch,
    ...(bridge ? { queueActionGate: bridge.queueActionGate } : {}),
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
  });
  // Normal runtime serves authenticated commands. Explicit 0 is an operator kill switch.
  if (enabled) await service.boot();
  const automationHandle = createAutomationHttp({
    service,
    enabled,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const bossCardsHandle = createBossCardsHttp({
    identify: service.identify,
    snapshots: bridge ? { ...snapshots, read: transport.fetch } : snapshots,
    getCatalogue,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const handle = async (request) => {
    const url = new URL(request.url);
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
      if (route.policy === "bridge_required" && request.method !== "GET")
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
      const identity = snapshots.identity(authorization);
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
        await service.identify(authorization);
        return new Response(
          JSON.stringify(snapshots.inventory(authorization)),
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
