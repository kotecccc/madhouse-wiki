import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifyProtocolPin } from "../scripts/bridge/check-protocol-pin.mjs";

test("generated Wiki protocol modules match their canonical source-tree pin", () => {
  const pin = verifyProtocolPin();
  assert.equal(pin.package, "@madhouse/bridge-protocol");
  assert.equal(pin.version, "1.4.3");
  assert.equal(pin.files.length, 11);
  assert.match(pin.sourceTreeSha256, /^[a-f0-9]{64}$/u);

  const parent = mkdtempSync(join(tmpdir(), "bridge-protocol-pin-"));
  const copy = join(parent, "protocol");
  try {
    cpSync(resolve("scripts/bridge/protocol-v1"), copy, { recursive: true });
    writeFileSync(join(copy, "challenge.mjs"), "// changed\n", {
      flag: "a",
    });
    assert.throws(
      () => verifyProtocolPin(copy),
      /bridge_protocol_pin_invalid/u,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
