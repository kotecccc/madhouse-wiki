import test from "node:test";
import assert from "node:assert/strict";
import {
  nextHealthWarningEvidence,
  hasConfirmedHealthWarning,
} from "../shared/game-health-warning.js";
const health = (checkedAt, feature = "bosses") => ({
  status: "unavailable",
  failedFeatures: [feature],
  featureCheckedAt: { [feature]: checkedAt },
});
test("three checks of the same service spaced fifteen seconds confirm a warning", () => {
  let evidence = nextHealthWarningEvidence({}, health(1000));
  assert.equal(hasConfirmedHealthWarning(health(1000), evidence), false);
  for (const time of [1000, 2000, 10000])
    evidence = nextHealthWarningEvidence(evidence, health(time));
  assert.equal(evidence.bosses.attempts, 1);
  evidence = nextHealthWarningEvidence(evidence, health(16000));
  assert.equal(hasConfirmedHealthWarning(health(16000), evidence), false);
  evidence = nextHealthWarningEvidence(evidence, health(31000));
  assert.equal(hasConfirmedHealthWarning(health(31000), evidence), true);
});
test("cached failures and unrelated successes cannot manufacture extra attempts", () => {
  let evidence = nextHealthWarningEvidence({}, health(1000));
  for (const time of [16000, 31000, 100000]) {
    const report = {
      ...health(1000),
      successfulFeatures: ["profile"],
      featureCheckedAt: { bosses: 1000, profile: time },
    };
    evidence = nextHealthWarningEvidence(evidence, report);
  }
  assert.equal(evidence.bosses.attempts, 1);
  evidence = nextHealthWarningEvidence(evidence, health(16000, "weapons"));
  assert.equal(evidence.weapons.attempts, 1);
  assert.equal(evidence.bosses, undefined);
  assert.equal(
    hasConfirmedHealthWarning(health(16000, "weapons"), evidence),
    false,
  );
});
test("recovery, identity reset and long gaps reset an unconfirmed failure sequence", () => {
  let evidence = nextHealthWarningEvidence({}, health(1000));
  evidence = nextHealthWarningEvidence(evidence, health(200000));
  assert.equal(evidence.bosses.attempts, 1);
  assert.deepEqual(
    nextHealthWarningEvidence(evidence, { status: "available" }),
    {},
  );
  assert.deepEqual(
    nextHealthWarningEvidence(evidence, { status: "unknown" }),
    {},
  );
  assert.equal(
    hasConfirmedHealthWarning({ status: "credentials_invalid" }, {}),
    true,
  );
  const missing = {
    status: "unavailable",
    failedFeatures: ["bosses"],
    featureCheckedAt: {},
  };
  let unproven = {};
  for (let i = 0; i < 10; i++)
    unproven = nextHealthWarningEvidence(unproven, missing);
  assert.equal(hasConfirmedHealthWarning(missing, unproven), false);
});

test("successful checks in a partially failed feature cannot count as failed attempts", () => {
  let evidence = {};
  for (const checkedAt of [1000, 16000, 31000]) {
    evidence = nextHealthWarningEvidence(evidence, {
      ...health(checkedAt),
      featureFailedAt: { bosses: 1000 },
    });
  }
  assert.equal(evidence.bosses.attempts, 1);
  assert.equal(hasConfirmedHealthWarning(health(31000), evidence), false);
});
