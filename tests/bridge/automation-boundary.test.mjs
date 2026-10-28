import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createAutomationRuntime } from "../../scripts/automation/runtime.mjs";

test("bridge identity guard rejects stale sessions and all automation mutations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-automation-"));
  let checks = 0;
  const bridge = {
    wrapSnapshots(snapshots) {
      return {
        fetch: snapshots.fetch,
        liveFetch: snapshots.liveFetch,
        async verifyLocal(authorization) {
          checks += 1;
          if (authorization !== "Bearer current") throw new Error("stale");
          return { policy: "bridge_required" };
        },
      };
    },
  };
  let runtime;
  try {
    runtime = await createAutomationRuntime({
      bridge,
      env: {
        MADHOUSE_AUTOMATION_STATE_DIR: directory,
        MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
      },
    });
    const post = new Request("http://localhost/api/automation/commands", {
      method: "POST",
      headers: {
        Authorization: "Bearer current",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const response = await runtime.handle(post);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "bridge_actions_disabled");
    const queued = await runtime.handle(
      new Request("http://localhost/api/automation/commands", {
        method: "POST",
        headers: {
          Authorization: "Bearer current",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: "queue.enqueue",
          args: {
            type: "friend.response",
            action: { playerId: 42, decision: "accept" },
          },
        }),
      }),
    );
    assert.equal(queued.status, 503);
    assert.equal(
      (await queued.json()).error,
      "automation_game_requests_disabled",
    );
    const stale = await runtime.handle(
      new Request("http://localhost/api/automation/profile-level", {
        headers: { Authorization: "Bearer stale" },
      }),
    );
    assert.equal(stale.status, 401);
    const current = await runtime.handle(
      new Request("http://localhost/api/automation/state", {
        headers: { Authorization: "Bearer current" },
      }),
    );
    assert.equal(current.status, 503);
    assert.equal(checks, 4);
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
