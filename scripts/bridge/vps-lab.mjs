import { createBridgeRuntime } from "./runtime.mjs";
import { createBridgeRateLimiter } from "./rate-limiter.mjs";
import { createBridgeNodeAdapter } from "./node-adapter.mjs";
import { createConnectorPrivateServer } from "./connector-private-server.mjs";
import { createRemoteConnectorGuard } from "./remote-connector-guard.mjs";

/** Explicitly gated wiring for isolated tests or the production origins. */
export function createVpsBridgeLab({
  role,
  env,
  wikiOrigin,
  connectorOrigin,
} = {}) {
  if (!env || !["wiki", "connector"].includes(role))
    throw new TypeError("bridge_lab_configuration_invalid");
  const lab = env.MADHOUSE_BRIDGE_LAB || "0";
  const production = env.MADHOUSE_BRIDGE_PRODUCTION || "0";
  if (
    !["0", "1"].includes(lab) ||
    !["0", "1"].includes(production) ||
    (lab === "1" && production === "1")
  )
    throw new Error("bridge_lab_configuration_invalid");
  if (lab === "0" && production === "0") return null;
  if (production === "1") {
    if (
      wikiOrigin !== "https://madhouse-wiki.ru" ||
      connectorOrigin !== "https://connect.madhouse-wiki.ru"
    )
      throw new Error("bridge_lab_origin_forbidden");
  } else {
    for (const origin of [wikiOrigin, connectorOrigin]) {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        !url.hostname.endsWith(".test")
      )
        throw new Error("bridge_lab_origin_forbidden");
    }
  }
  if (!/^[a-f0-9]{64}$/.test(env.MADHOUSE_BRIDGE_IPC_KEY || ""))
    throw new Error("bridge_lab_key_required");
  const key = Buffer.from(env.MADHOUSE_BRIDGE_IPC_KEY, "hex");
  if (role === "connector") {
    const guard = createRemoteConnectorGuard({
      endpoint: "http://wiki:9094/internal/bridge/connector-lease",
      key,
      verificationKey: env.WIKI_INITDATA_KEY,
    });
    return Object.freeze({ guard });
  }
  if (
    !env.MADHOUSE_BRIDGE_STATE_DIR ||
    !env.MADHOUSE_BRIDGE_WITNESS_PATH ||
    !env.TELEGRAM_BOT_TOKEN
  )
    throw new Error("bridge_lab_storage_required");
  const limiter = createBridgeRateLimiter();
  const runtime = createBridgeRuntime({
    directory: env.MADHOUSE_BRIDGE_STATE_DIR,
    witnessPath: env.MADHOUSE_BRIDGE_WITNESS_PATH,
    provisionWitness: env.MADHOUSE_BRIDGE_PROVISION_WITNESS === "1",
    botToken: env.TELEGRAM_BOT_TOKEN,
    origin: wikiOrigin,
    consume: limiter.consume,
    connectorIpcKey: key,
  });
  try {
    const adapter = createBridgeNodeAdapter({ runtime, origin: wikiOrigin });
    const privateServer = createConnectorPrivateServer({
      handle: runtime.connectorLease,
    });
    return Object.freeze({ runtime, adapter, privateServer });
  } catch (error) {
    runtime.close();
    throw error;
  }
}
