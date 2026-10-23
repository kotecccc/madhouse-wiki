import { connectorOrigin, VERSION } from "../../connector/protocol.js";
export function productionConnectorConfig(config, required = false) {
  if (!config?.origin) {
    if (required)
      throw new Error(
        "An enabled HTTPS Telegram connector is required for this release",
      );
    return null;
  }
  const origin = connectorOrigin(config.origin);
  const url = origin && new URL(origin);
  if (
    !url ||
    url.protocol !== "https:" ||
    config.protocolVersion !== VERSION ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":")
  )
    throw new Error(
      "A production release cannot contain a local or invalid Telegram connector origin",
    );
  return { origin, protocolVersion: VERSION };
}
