import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function bridgeBootstrapSha(config) {
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(",") !== "bootstrapSha256,enabled" ||
    typeof config.enabled !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(config.bootstrapSha256 || "")
  )
    throw new Error("invalid_bridge_release_config");
  return config.enabled ? config.bootstrapSha256 : "";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(
    readFileSync(new URL("./release-config.json", import.meta.url), "utf8"),
  );
  process.stdout.write(bridgeBootstrapSha(config));
}
