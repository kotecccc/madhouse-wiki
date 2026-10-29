import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAutomationRuntime,
  globalRaidsDestination,
} from "../scripts/automation/runtime.mjs";

test("global raid destination accepts a public channel or numeric chat ID", () => {
  assert.equal(
    globalRaidsDestination("@madhouse_wiki_raids"),
    "@madhouse_wiki_raids",
  );
  assert.equal(globalRaidsDestination("-1001234567890"), "-1001234567890");
  for (const invalid of [
    undefined,
    "",
    "https://t.me/madhouse_wiki_raids/3",
    "@bad",
    "123",
    "@space channel",
  ]) {
    assert.equal(globalRaidsDestination(invalid), null);
  }
});

test("normal automation runtime is enabled; only explicit 0 returns the operator kill switch", async () => {
  for (const flag of [undefined, "1", "0"]) {
    const directory = mkdtempSync(join(tmpdir(), "automation-runtime-"));
    let runtime;
    try {
      runtime = await createAutomationRuntime({
        env: {
          MADHOUSE_AUTOMATION_STATE_DIR: directory,
          ...(flag === undefined
            ? {}
            : { MADHOUSE_AUTOMATION_GAME_ENABLED: flag }),
        },
      });
      // No credentials: enabled runtimes reject before any upstream game read.
      const response = await runtime.handle(
        new Request("http://localhost/api/automation/state"),
      );
      const body = await response.json();
      assert.equal(response.status, flag === "0" ? 503 : 401);
      assert.equal(
        body.error,
        flag === "0"
          ? "automation_game_requests_disabled"
          : "game_session_required",
      );
    } finally {
      runtime?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
