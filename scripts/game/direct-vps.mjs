import { createDirectBoundary } from "./direct-boundary.mjs";
import {
  createDirectGameIpcClient,
  createDirectGameIpcServer,
} from "./direct-ipc.mjs";

export function createDirectVpsOwner({
  env,
  fetcher,
  credentialCurrent = () => true,
  bindingCurrent = () => false,
  resolvePlayer = () => null,
  requireBridgeJournal = false,
} = {}) {
  const boundary = createDirectBoundary({
    env,
    resolvePlayer,
    requireBridgeJournal,
    ...(fetcher ? { fetcher } : {}),
  });
  const wikiFetch = (url, init) => boundary.request(url, init, "wiki");
  const server = createDirectGameIpcServer({
    secret: env.MADHOUSE_GAME_EXECUTOR_KEY,
    execute: (url, init) => {
      const { gameBinding, ...requestInit } = init;
      const authorization = new Headers(init.headers).get("authorization");
      return boundary.request(
        url,
        {
          ...requestInit,
          canDispatch: async () =>
            (!authorization || (await credentialCurrent(authorization))) &&
            (!gameBinding || (await bindingCurrent(gameBinding))),
        },
        "connector",
      );
    },
  });
  return { boundary, wikiFetch, server };
}

export function createDirectVpsConnector({ env, fetcher } = {}) {
  return createDirectGameIpcClient({
    endpoint: env.MADHOUSE_GAME_EXECUTOR_ORIGIN + "/internal/game/direct",
    secret: env.MADHOUSE_GAME_EXECUTOR_KEY,
    ...(fetcher ? { fetcher } : {}),
  });
}
