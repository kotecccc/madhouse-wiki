import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createWeaponRecoveryFetch } from "../../scripts/bridge/weapon-recovery-fetch.mjs";

test("automatic repair is admitted once only for its saved weapon operation", async () => {
  const gate = createQueueActionGate();
  const entry = {
    equipment: {
      pending: {
        id: "job",
        type: "weapon",
        entityId: 7,
        action: "repair",
        operationId: "op",
      },
    },
  };
  let sent = 0;
  const fetcher = async (url, init) => {
    const request = {
      authorization: new Headers(init.headers).get("authorization"),
      method: init.method,
      path: new URL(url).pathname,
      body: init.body,
    };
    assert.equal(
      gate.claim({
        ...request,
        body: JSON.stringify({ weaponId: 8, operationId: "op" }),
      }),
      false,
    );
    assert.equal(gate.claim(request), true);
    assert.equal(gate.claim(request), false);
    sent++;
    return new Response("{}");
  };
  const wrapped = createWeaponRecoveryFetch({
    fetcher,
    gate,
    entry,
    allowed: () => true,
  });
  await wrapped("https://cargohustle.online/api/weapons/repair", {
    method: "POST",
    headers: { Authorization: "Bearer fake" },
    body: JSON.stringify({ weaponId: 7, operationId: "op" }),
  });
  assert.equal(sent, 1);
  assert.throws(
    () =>
      wrapped("https://cargohustle.online/api/weapons/repair", {
        method: "POST",
        headers: { Authorization: "Bearer fake" },
        body: JSON.stringify({ weaponId: 8, operationId: "op" }),
      }),
    /weapon_checkpoint_missing/,
  );
});
