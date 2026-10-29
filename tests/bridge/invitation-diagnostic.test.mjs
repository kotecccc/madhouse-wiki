import assert from "node:assert/strict";
import { test } from "node:test";
import { invitationResponseDiagnostic } from "../../scripts/bridge/profile-client.mjs";

test("invitation diagnostics classify known reasons and never reveal response text", () => {
  const privateText = "private-token-and-account-data";
  const diagnostic = invitationResponseDiagnostic(
    Buffer.from(
      JSON.stringify({
        reason: "boss_battle_already_active",
        message: privateText,
        account: privateText,
      }),
    ),
  );
  assert.equal(diagnostic.reason, "boss_battle_already_active");
  assert.match(
    diagnostic.fingerprints,
    /^reason:[a-f0-9]{16},message:[a-f0-9]{16}$/,
  );
  assert.ok(!JSON.stringify(diagnostic).includes(privateText));
  assert.deepEqual(invitationResponseDiagnostic(Buffer.from(privateText)), {
    reason: "other",
    fingerprints: "non_json",
  });
  assert.deepEqual(invitationResponseDiagnostic(Buffer.from("{}")), {
    reason: "other",
    fingerprints: "no_string_fields",
  });
});
