import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";
import { localStopCommands } from "../scripts/automation/http.mjs";
import { isLocalAutomationCommand } from "../shared/auth-session.js";

test("the client can authorize every server-local stop command", () => {
  for (const command of localStopCommands)
    assert.equal(
      isLocalAutomationCommand(
        { url: "/api/automation/commands", method: "POST" },
        command,
        "https://wiki.test",
      ),
      true,
    );
});

const claims = Buffer.from(
  JSON.stringify({
    v: 1,
    legacy: false,
    accountPath: `accounts/${"a".repeat(64)}.json`,
  }),
).toString("base64url");
const wikiToken = `test.${claims}.signature`;
test("Wiki session can stop a saved automation without a game credential or game traffic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wiki-local-stop-"));
  const store = createAutomationStateStore({ directory });
  store.write("42", {
    credential: "Bearer expired-token",
    player: { playerId: 42 },
    version: 1,
  });
  store.close();
  let gameCalls = 0;
  const runtime = await createAutomationRuntime({
    env: { MADHOUSE_AUTOMATION_STATE_DIR: directory },
    wikiSessionAuthority: {
      verify: async (token) =>
        token === wikiToken ? { playerId: 42, telegramUserId: "42" } : null,
    },
    gameFetcher: async () => {
      gameCalls++;
      throw new Error("unexpected game call");
    },
  });
  try {
    const headers = {
      authorization: `Bearer ${wikiToken}`,
      "content-type": "application/json",
    };
    const initial = await runtime.handle(
      new Request("https://wiki.test/api/automation/state", { headers }),
    );
    assert.equal(initial.status, 200);
    const state = await initial.json();
    const stop = await runtime.handle(
      new Request("https://wiki.test/api/automation/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "local-stop-1",
          command: "auto.stop",
          expectedVersion: state.version,
        }),
      }),
    );
    assert.equal(stop.status, 200);
    const denied = await runtime.handle(
      new Request("https://wiki.test/api/automation/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "local-start-1",
          command: "auto.start",
          expectedVersion: state.version,
        }),
      }),
    );
    assert.equal(denied.status, 401);
    assert.equal(gameCalls, 0);
  } finally {
    runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
