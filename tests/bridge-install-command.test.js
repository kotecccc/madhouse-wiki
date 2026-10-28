import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createBridgeInstallCommand } from "../shared/bridge-install-command.js";

test("one command pins the bootstrap and carries only a short-lived invitation", () => {
  const invitation = "A".repeat(43);
  const digest = "a".repeat(64);
  const command = createBridgeInstallCommand({
    invitation,
    bootstrapSha256: digest,
  });
  assert.match(command, /https:\/\/madhouse-wiki\.ru\/bridge\/bootstrap\.pyz/);
  assert.ok(command.includes(digest));
  assert.ok(command.includes(invitation));
  assert.match(command, /sha256/);
  assert.match(command, /NoRedirect/);
  assert.match(command, /--pair/);
  assert.equal(spawnSync("/bin/sh", ["-n"], { input: command }).status, 0);
});

test("rejects values that could alter the shell command", () => {
  for (const invitation of ["x';echo hacked;#", "a".repeat(42), "$(whoami)"]) {
    assert.throws(
      () =>
        createBridgeInstallCommand({
          invitation,
          bootstrapSha256: "a".repeat(64),
        }),
      TypeError,
    );
  }
  assert.throws(
    () =>
      createBridgeInstallCommand({
        invitation: "A".repeat(43),
        bootstrapSha256: "x".repeat(64),
      }),
    TypeError,
  );
});
