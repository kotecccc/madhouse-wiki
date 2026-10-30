import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAutomationRuntime,
  globalRaidsDestination,
} from "../scripts/automation/runtime.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

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

test("direct profile level reads use the injected game transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-runtime-"));
  const calls = [];
  let runtime;
  try {
    runtime = await createAutomationRuntime({
      env: {
        MADHOUSE_AUTOMATION_STATE_DIR: directory,
        MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
      },
      gameFetcher: async (url) => {
        calls.push(new URL(url).pathname);
        if (new URL(url).pathname === "/api/me")
          return Response.json({ playerId: 41 });
        if (new URL(url).pathname === "/api/players/41")
          return Response.json({ playerId: 41, level: 136 });
        throw new Error("unexpected game request");
      },
    });
    await runtime.gameFetch("https://cargohustle.online/api/me", {
      headers: { Authorization: "Bearer test" },
    });
    const response = await runtime.handle(
      new Request("http://localhost/api/automation/profile-level", {
        headers: { Authorization: "Bearer test" },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { playerId: 41, level: 136 });
    assert.deepEqual(calls, ["/api/me", "/api/players/41"]);
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a verified queue intent is durably accepted while an unrelated game read is stalled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-queued-intent-"));
  let release;
  let runtime;
  const calls = [];
  try {
    runtime = await createAutomationRuntime({
      env: { MADHOUSE_AUTOMATION_STATE_DIR: directory },
      gameFetcher: async (url, init = {}) => {
        const path = new URL(url).pathname;
        calls.push([path, init.method || "GET"]);
        if (path === "/api/me")
          return Response.json({ playerId: 41, nickname: "Fake" });
        if (path === "/api/me/bag")
          return new Promise((resolve) => {
            release = () => resolve(Response.json({ items: [] }));
          });
        throw new Error("unexpected game request");
      },
    });
    const headers = { Authorization: "Bearer test" };
    await runtime.gameFetch("https://cargohustle.online/api/me", { headers });
    const stuck = runtime.gameFetch("https://cargohustle.online/api/me/bag", {
      headers,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const command = runtime.handle(
      new Request("http://localhost/api/automation/commands", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "queue-intent-test",
          command: "queue.enqueue",
          expectedVersion: 0,
          args: {
            type: "auto.start",
            action: {
              settings: {
                bossId: 7,
                kind: "battles",
                targetCount: 1,
                durationHours: null,
              },
            },
          },
        }),
      }),
    );
    const response = await Promise.race([
      command,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("command waited for game read")),
          250,
        ),
      ),
    ]);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.queuedActions[0].id, "queue-intent-test");
    assert.equal(state.queuedActions[0].status, "queued");
    const persisted = createAutomationStateStore({ directory });
    try {
      assert.equal(
        persisted.read("41").queuedActions[0].id,
        "queue-intent-test",
      );
      assert.ok(persisted.read("41").receipts.includes("queue-intent-test"));
    } finally {
      persisted.close();
    }
    assert.deepEqual(calls, [
      ["/api/me", "GET"],
      ["/api/me/bag", "GET"],
    ]);
    release();
    await stuck;
  } finally {
    release?.();
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
