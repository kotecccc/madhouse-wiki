import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_VERSION,
  PROTOCOL_PACKAGE,
  REQUIRED_HOST_CONFIGURATION_VERSION,
  SERVER_SCHEMA_VERSIONS,
  createBridgeCompatibility,
} from "../scripts/deploy/release-compatibility.mjs";
import {
  CONTROL_CAPABILITIES,
  PROTOCOL_VERSION,
} from "../scripts/bridge/protocol-v1/control.mjs";

const sourceCommit = "a".repeat(40);
const r0Commit = "b".repeat(40);
const readyEnv = {
  MADHOUSE_RELEASE_SHA: sourceCommit,
  MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: r0Commit,
  MADHOUSE_BRIDGE_R0_RELEASE_SHA: r0Commit,
  MADHOUSE_HOST_CONFIG_VERSION: String(REQUIRED_HOST_CONFIGURATION_VERSION),
  MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "1",
  MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED: "1",
  MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED: "1",
};

test("Wiki release compatibility separates application, protocol and schema versions", () => {
  const release = createBridgeCompatibility({
    sourceCommit,
    env: { MADHOUSE_RELEASE_SHA: sourceCommit },
  });
  assert.equal(release.applicationVersion, APPLICATION_VERSION);
  assert.equal(release.sourceCommit, sourceCommit);
  assert.deepEqual(release.wireProtocol, PROTOCOL_VERSION);
  assert.deepEqual(release.protocolPackage, PROTOCOL_PACKAGE);
  assert.deepEqual(release.schemaVersions, SERVER_SCHEMA_VERSIONS);
  assert.deepEqual(release.controlCapabilities, CONTROL_CAPABILITIES);
  assert.equal(release.minimumSafeRollbackCommit, null);
  assert.deepEqual(release.routeSelection, {
    requested: false,
    enabled: false,
    disabledReason: "not_requested",
  });
});

test("route selection requires an explicit request, the R0 rollback floor and matching host config", () => {
  const release = createBridgeCompatibility({
    sourceCommit,
    env: readyEnv,
  });
  assert.deepEqual(release.routeSelection, {
    requested: true,
    enabled: true,
    disabledReason: null,
  });
  assert.equal(release.minimumSafeRollbackCommit, r0Commit);
  assert.equal(release.r0ReleaseCommit, r0Commit);
  assert.equal(
    release.hostConfigurationVersion,
    REQUIRED_HOST_CONFIGURATION_VERSION,
  );
});

test("route selection fails closed on missing or inconsistent R0 readiness inputs", () => {
  const cases = [
    [{ MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "0" }, "not_requested"],
    [
      { ...readyEnv, MADHOUSE_RELEASE_SHA: "c".repeat(40) },
      "release_commit_mismatch",
    ],
    [
      { ...readyEnv, MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: "" },
      "rollback_floor_missing",
    ],
    [{ ...readyEnv, MADHOUSE_BRIDGE_R0_RELEASE_SHA: "" }, "r0_release_missing"],
    [
      { ...readyEnv, MADHOUSE_BRIDGE_R0_RELEASE_SHA: "c".repeat(40) },
      "rollback_floor_not_r0",
    ],
    [
      { ...readyEnv, MADHOUSE_HOST_CONFIG_VERSION: "" },
      "host_configuration_incompatible",
    ],
    [
      { ...readyEnv, MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED: "" },
      "legacy_egress_unverified",
    ],
    [
      { ...readyEnv, MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED: "" },
      "storage_credential_path_unverified",
    ],
    [
      { ...readyEnv, MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: "invalid" },
      "rollback_floor_invalid",
    ],
  ];
  for (const [env, disabledReason] of cases) {
    const release = createBridgeCompatibility({ sourceCommit, env });
    assert.equal(
      release.routeSelection.requested,
      env.MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED === "1",
    );
    assert.equal(release.routeSelection.enabled, false);
    assert.equal(release.routeSelection.disabledReason, disabledReason);
  }
});

test("route selection fails closed when the running release identity is unavailable", () => {
  const release = createBridgeCompatibility({
    sourceCommit: "unknown",
    env: readyEnv,
  });
  assert.equal(release.sourceCommit, null);
  assert.deepEqual(release.routeSelection, {
    requested: true,
    enabled: false,
    disabledReason: "release_commit_unavailable",
  });
});
