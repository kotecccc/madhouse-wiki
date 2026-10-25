import { createBossCardsHttp } from "../account/boss-cards.mjs";
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
} = {}) {
  const enabled = env.MADHOUSE_AUTOMATION_GAME_ENABLED !== "0";
  const store = createAutomationStateStore({
    directory:
      env.MADHOUSE_AUTOMATION_STATE_DIR ||
      resolve(root, "local-data/automation"),
  });
  const snapshots = createAccountSnapshots({ store });
  const proxy = createProxy(snapshots.fetch);
  let catalogue;
  const getCatalogue = () => (catalogue ??= readKnowledgeBase(root));
  const service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async (authorization) => {
      const response = await snapshots.read(
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
    snapshots,
    getCatalogue,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const handle = (request) =>
    new URL(request.url).pathname === "/api/automation/bosses"
      ? bossCardsHandle(request)
      : automationHandle(request);
  return {
    handle,
    proxy,
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
