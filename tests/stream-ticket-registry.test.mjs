import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createStreamTicketRegistry } from "../scripts/bridge/stream-ticket-registry.mjs";

const session = Object.freeze({
  ownerId: "54321",
  deviceId: "00000000-0000-4000-8000-000000000401",
  deviceGeneration: 2,
  connectionId: "00000000-0000-4000-8000-000000000402",
  routeEpoch: 9,
  expiresAtMs: Date.now() + 60_000,
  scopes: ["control", "data"],
});

function fixture({ now = Date.now(), maxPending = 8 } = {}) {
  let timestamp = now;
  const registry = createStreamTicketRegistry({
    sessionSigningKey: new Uint8Array(32).fill(77),
    now: () => timestamp,
    maxPending,
  });
  return {
    registry,
    setNow(value) {
      timestamp = value;
    },
  };
}

async function issue(registry, overrides = {}) {
  return registry.issue({
    session,
    streamId: randomUUID(),
    ...overrides,
  });
}

test("stream tickets bind a pseudonymous owner, route and single-use id", async () => {
  const { registry } = fixture();
  const { ticket, claims } = await issue(registry);
  assert.equal(claims.ownerRef, registry.ownerRefFor(session.ownerId));
  assert.notEqual(claims.ownerRef, session.ownerId);
  assert.equal(claims.deviceId, session.deviceId);
  assert.equal(claims.connectionId, session.connectionId);
  assert.equal(claims.routeEpoch, session.routeEpoch);
  assert.equal(claims.target, "cargo-main");
  assert.equal("ownerId" in claims, false);

  const consumed = await registry.consume(ticket, session);
  assert.deepEqual(consumed, claims);
  await assert.rejects(registry.consume(ticket, session), {
    code: "stream_ticket_replayed",
  });
  assert.equal(registry.pendingCount, 0);
});

test("ticket consumption is atomic under concurrent data-channel upgrades", async () => {
  const { registry } = fixture();
  const { ticket } = await issue(registry);
  const results = await Promise.allSettled([
    registry.consume(ticket, session),
    registry.consume(ticket, session),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
});

test("ticket is consumed and rejected when presented by another session", async () => {
  const { registry } = fixture();
  const { ticket } = await issue(registry);
  const otherSession = { ...session, ownerId: "54322" };
  await assert.rejects(registry.consume(ticket, otherSession), {
    code: "stream_ticket_invalid",
  });
  await assert.rejects(registry.consume(ticket, session), {
    code: "stream_ticket_replayed",
  });
});

test("expired tickets fail and are pruned from the outstanding limit", async () => {
  const issuedAtMs = Date.now();
  const { registry, setNow } = fixture({ now: issuedAtMs });
  const { ticket } = await issue(registry);
  setNow(issuedAtMs + 15_000);
  await assert.rejects(registry.consume(ticket, session), {
    code: "stream_ticket_invalid",
  });
  assert.equal(registry.pendingCount, 0);
});

test("one outstanding ticket is allowed per connection and disconnect clears it", async () => {
  const { registry } = fixture({ maxPending: 1 });
  const { ticket } = await issue(registry);
  await assert.rejects(issue(registry), { code: "stream_limit" });
  assert.equal(registry.clearConnection(session.connectionId), true);
  const next = await issue(registry);
  assert.notEqual(next.ticket, ticket);
  registry.clear();
  assert.equal(registry.pendingCount, 0);
});

test("owner references are stable per key and differ across owners and keys", () => {
  const { registry } = fixture();
  const other = createStreamTicketRegistry({
    sessionSigningKey: new Uint8Array(32).fill(78),
  });
  assert.equal(registry.ownerRefFor("54321"), registry.ownerRefFor("54321"));
  assert.notEqual(registry.ownerRefFor("54321"), registry.ownerRefFor("54322"));
  assert.notEqual(registry.ownerRefFor("54321"), other.ownerRefFor("54321"));
});
