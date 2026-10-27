import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_CAPABILITIES,
  PROTOCOL_VERSION,
} from "../bridge/protocol-v1/control.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPackage = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);
const protocolSource = JSON.parse(
  readFileSync(
    resolve(root, "scripts/bridge/protocol-v1/protocol-source.json"),
    "utf8",
  ),
);
const RELEASE_SHA = /^[a-f0-9]{40}$/u;
export const REQUIRED_HOST_CONFIGURATION_VERSION = 1;
export const APPLICATION_VERSION = appPackage.version;
export const PROTOCOL_PACKAGE = Object.freeze({
  name: protocolSource.package,
  version: protocolSource.version,
  sourceTreeSha256: protocolSource.sourceTreeSha256,
});
export const SERVER_SCHEMA_VERSIONS = Object.freeze({
  automationState: 1,
  bridgeDeviceRegistry: 1,
  gameCredential: 1,
  routePolicy: 1,
});

export function createBridgeCompatibility({ sourceCommit, env = process.env }) {
  const requested = env.MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED === "1";
  const configuredRelease = env.MADHOUSE_RELEASE_SHA || "";
  const floorValue = env.MADHOUSE_MINIMUM_SAFE_RELEASE_SHA || "";
  const r0Value = env.MADHOUSE_BRIDGE_R0_RELEASE_SHA || "";
  const minimumSafeRollbackCommit = RELEASE_SHA.test(floorValue)
    ? floorValue
    : null;
  const r0ReleaseCommit = RELEASE_SHA.test(r0Value) ? r0Value : null;
  const hostConfigurationVersion = /^[1-9][0-9]*$/u.test(
    env.MADHOUSE_HOST_CONFIG_VERSION || "",
  )
    ? Number(env.MADHOUSE_HOST_CONFIG_VERSION)
    : null;
  let disabledReason = "not_requested";

  if (requested) {
    if (!RELEASE_SHA.test(sourceCommit || ""))
      disabledReason = "release_commit_unavailable";
    else if (configuredRelease !== sourceCommit)
      disabledReason = "release_commit_mismatch";
    else if (!minimumSafeRollbackCommit)
      disabledReason = floorValue
        ? "rollback_floor_invalid"
        : "rollback_floor_missing";
    else if (!r0ReleaseCommit)
      disabledReason = r0Value ? "r0_release_invalid" : "r0_release_missing";
    else if (minimumSafeRollbackCommit !== r0ReleaseCommit)
      disabledReason = "rollback_floor_not_r0";
    else if (
      env.MADHOUSE_HOST_CONFIG_VERSION !==
      String(REQUIRED_HOST_CONFIGURATION_VERSION)
    )
      disabledReason = "host_configuration_incompatible";
    else if (env.MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED !== "1")
      disabledReason = "legacy_egress_unverified";
    else if (env.MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED !== "1")
      disabledReason = "storage_credential_path_unverified";
    else disabledReason = null;
  }

  return {
    applicationVersion: APPLICATION_VERSION,
    sourceCommit: RELEASE_SHA.test(sourceCommit || "") ? sourceCommit : null,
    wireProtocol: { ...PROTOCOL_VERSION },
    protocolPackage: { ...PROTOCOL_PACKAGE },
    schemaVersions: { ...SERVER_SCHEMA_VERSIONS },
    controlCapabilities: [...CONTROL_CAPABILITIES],
    hostConfigurationVersion,
    requiredHostConfigurationVersion: REQUIRED_HOST_CONFIGURATION_VERSION,
    minimumSafeRollbackCommit,
    r0ReleaseCommit,
    routeSelection: {
      requested,
      enabled: requested && disabledReason === null,
      disabledReason,
    },
  };
}
