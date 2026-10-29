import test from "node:test";
import assert from "node:assert/strict";
import { createAutomationHttp } from "./http.mjs";

test("inventory failures expose only bounded safe reasons", async () => {
  let reason = "inventory_price_changed";
  const service = {
    identify: async () => ({}),
    snapshot: () => ({}),
    command: async () => {
      throw Object.assign(new Error(reason), { status: 409 });
    },
  };
  const handle = createAutomationHttp({ service });
  const request = () =>
    new Request("https://example.test/api/automation/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "inventory.action" }),
    });
  assert.equal(
    (await (await handle(request())).json()).inventoryReason,
    reason,
  );
  reason = "secret-token: abc123";
  assert.equal(
    (await (await handle(request())).json()).inventoryReason,
    undefined,
  );
});

test("only a version conflict is marked as safe to rebase", async () => {
  let reason = "automation_state_changed";
  const service = {
    identify: async () => ({}),
    snapshot: () => ({}),
    command: async () => {
      throw Object.assign(new Error(reason), { status: 409 });
    },
  };
  const handle = createAutomationHttp({ service });
  const request = () =>
    new Request("https://example.test/api/automation/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "open" }),
    });
  assert.equal(
    (await (await handle(request())).json()).conflictReason,
    "version",
  );
  reason = "raid_controls_the_battle";
  assert.equal(
    (await (await handle(request())).json()).conflictReason,
    undefined,
  );
});

test("state GET uses the stored identity without game identity requests", async () => {
  let identifyCalls = 0;
  let readCalls = 0;
  const service = {
    identify: async () => {
      identifyCalls++;
      throw new Error("game must not be consulted");
    },
    readStored: async () => {
      readCalls++;
      return { playerId: "101" };
    },
    snapshot: (entry) => ({ playerId: entry.playerId }),
  };
  const handle = createAutomationHttp({ service, enabled: true });
  const response = await handle(
    new Request("https://example.test/api/automation/state", {
      headers: { authorization: "Bearer saved-token" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { playerId: "101" });
  assert.equal(readCalls, 1);
  assert.equal(identifyCalls, 0);
});

test("local stop commands use the stored identity rather than game identity", async () => {
  let identified = 0;
  const service = {
    readStored: async () => ({}),
    identify: async () => {
      identified++;
      throw new Error("must not identify against game");
    },
    command: async (_entry, input) => ({ stopped: input.command }),
    snapshot: () => ({}),
  };
  const handle = createAutomationHttp({ service, enabled: true });
  const response = await handle(
    new Request("https://example.test/api/automation/commands", {
      method: "POST",
      headers: {
        authorization: "Bearer saved-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "auto.stop" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { stopped: "auto.stop" });
  assert.equal(identified, 0);
});
