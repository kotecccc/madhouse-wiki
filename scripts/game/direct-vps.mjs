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
  bootstrapPolicy = null,
} = {}) {
  const trustedBootstraps = new WeakSet();
  const boundary = createDirectBoundary({
    env,
    resolvePlayer,
    requireBridgeJournal,
    isTrustedBootstrap: (permit) => trustedBootstraps.has(permit),
    ...(fetcher ? { fetcher } : {}),
  });
  const wikiFetch = (url, init) => boundary.request(url, init, "wiki");
  const server = createDirectGameIpcServer({
    secret: env.MADHOUSE_GAME_EXECUTOR_KEY,
    execute: (url, init) => {
      const { gameBinding, gameBootstrap, ...requestInit } = init;
      const authorization = new Headers(init.headers).get("authorization");
      let permit;
      if (gameBootstrap && bootstrapPolicy) {
        const { owner, leaseId, step, attempt, credentialDigest } =
          gameBootstrap;
        const args = [owner, leaseId, step, attempt, credentialDigest];
        permit = Object.freeze({
          validate: () => bootstrapPolicy.canClaim(...args) === true,
          claim: () => bootstrapPolicy.claim(...args),
          complete: (status) =>
            bootstrapPolicy.complete(owner, leaseId, step, attempt, status),
        });
        trustedBootstraps.add(permit);
      }
      if (gameBootstrap && !permit)
        throw Object.assign(new Error("bootstrap_unavailable"), {
          notDispatched: true,
        });
      return boundary.request(
        url,
        {
          ...requestInit,
          ...(permit ? { gameBootstrapPermit: permit } : {}),
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
