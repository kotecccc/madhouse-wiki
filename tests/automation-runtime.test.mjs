import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";

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
