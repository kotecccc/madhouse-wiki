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
