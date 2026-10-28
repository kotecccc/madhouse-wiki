import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeBootstrapSha } from "../../scripts/bridge/release-config.mjs";

test("bootstrap checksum remains disabled until bridge rollout is enabled", () => {
  const bootstrapSha256 = "a".repeat(64);
  assert.equal(bridgeBootstrapSha({ enabled: false, bootstrapSha256 }), "");
  assert.equal(
    bridgeBootstrapSha({ enabled: true, bootstrapSha256 }),
    bootstrapSha256,
  );
  for (const config of [
    null,
    {},
    { enabled: true, bootstrapSha256: "bad" },
    { enabled: "true", bootstrapSha256 },
  ])
    assert.throws(() => bridgeBootstrapSha(config), {
      message: "invalid_bridge_release_config",
    });
});
