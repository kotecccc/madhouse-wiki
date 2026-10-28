import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import {
  createConnectorLeaseIpcClient,
  createConnectorLeaseIpcHandler,
} from "../../scripts/bridge/connector-lease-ipc.mjs";

const endpoint = "http://wiki:9094/internal/bridge/connector-lease";
const now = 1_800_000_000_000;

test("authenticated IPC acquires, marks and releases a durable owner lease without replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ipc-"));
  const storage = createBridgeStorage({ directory });
  const key = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases: storage.connectorLeases,
    consumeNonce: storage.consumeConnectorNonce,
    key,
    now: () => now,
  });
  let captured;
  const client = createConnectorLeaseIpcClient({
    endpoint,
    key,
    now: () => now,
    fetcher: async (url, init) => {
      const request = new Request(url, init);
      captured = request.clone();
      return handler(request, true);
    },
  });
  try {
    const id = await client.acquire("101", "telegram_auth");
    assert.equal(storage.connectorLeases.pending("101").length, 1);
    assert.equal((await handler(captured.clone(), true)).status, 409);
    assert.equal(storage.connectorLeases.pending("101").length, 1);
    await client.markDispatched("101", id);
    assert.equal(storage.connectorLeases.pending("101")[0].phase, "dispatched");
    assert.equal(
      await client.finish("101", id, { definitelyFinished: true }),
      true,
    );
    assert.deepEqual(storage.connectorLeases.pending("101"), []);
    assert.equal((await handler(captured.clone(), false)).status, 404);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bad key and private endpoint substitutions fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ipc-"));
  const storage = createBridgeStorage({ directory });
  const key = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases: storage.connectorLeases,
    consumeNonce: storage.consumeConnectorNonce,
    key,
    now: () => now,
  });
  try {
    assert.throws(
      () =>
        createConnectorLeaseIpcClient({
          endpoint: "http://attacker:9094/internal/bridge/connector-lease",
          key,
        }),
      TypeError,
    );
    const client = createConnectorLeaseIpcClient({
      endpoint,
      key: randomBytes(32),
      now: () => now,
      fetcher: (url, init) => handler(new Request(url, init), true),
    });
    await assert.rejects(client.acquire("101", "telegram_auth"), {
      code: "bridge_unavailable",
    });
    assert.deepEqual(storage.connectorLeases.pending("101"), []);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("nonce receipts survive restart and reject backwards clock", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-ipc-"));
  let storage = createBridgeStorage({ directory });
  try {
    const nonce = "a".repeat(32);
    assert.equal(storage.consumeConnectorNonce(nonce, now), true);
    storage.close();
    storage = createBridgeStorage({ directory });
    assert.equal(storage.consumeConnectorNonce(nonce, now), false);
    assert.equal(storage.consumeConnectorNonce("b".repeat(32), now - 1), false);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lost acquire response is never replayed and remains fenced", async () => {
  const { createConnectorOwnerGuard } =
    await import("../../scripts/bridge/connector-owner-guard.mjs");
  const directory = mkdtempSync(join(tmpdir(), "bridge-ipc-"));
  const storage = createBridgeStorage({ directory });
  const key = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases: storage.connectorLeases,
    consumeNonce: storage.consumeConnectorNonce,
    key,
    now: () => now,
  });
  let calls = 0;
  const client = createConnectorLeaseIpcClient({
    endpoint,
    key,
    now: () => now,
    fetcher: async (url, init) => {
      calls += 1;
      await handler(new Request(url, init), true);
      throw new Error("response lost");
    },
  });
  const guard = createConnectorOwnerGuard({
    verifyOwner: async () => "101",
    leases: client,
  });
  try {
    await assert.rejects(
      guard.withGameSessionLease("verified", "user=%7B%22id%22%3A101%7D", () =>
        assert.fail("must not send game request"),
      ),
      { code: "bridge_unavailable" },
    );
    assert.equal(calls, 1);
    assert.equal(storage.connectorLeases.pending("101")[0].phase, "prepared");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tampered, unsigned and replayed responses never authorize a game request", async () => {
  const { createConnectorOwnerGuard } =
    await import("../../scripts/bridge/connector-owner-guard.mjs");
  for (const alteration of [
    "body",
    "status",
    "signature",
    "unsigned",
    "replay",
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "bridge-ipc-response-"));
    const storage = createBridgeStorage({ directory });
    const key = randomBytes(32);
    const handler = createConnectorLeaseIpcHandler({
      leases: storage.connectorLeases,
      consumeNonce: storage.consumeConnectorNonce,
      key,
      now: () => now,
    });
    let saved;
    const client = createConnectorLeaseIpcClient({
      endpoint,
      key,
      now: () => now,
      fetcher: async (url, init) => {
        const response = await handler(new Request(url, init), true);
        const bytes = await response.arrayBuffer();
        const responseHeaders = new Headers(response.headers);
        if (alteration === "replay") {
          if (!saved) {
            saved = { bytes, headers: responseHeaders };
            return new Response(bytes, {
              status: response.status,
              headers: responseHeaders,
            });
          }
          return new Response(saved.bytes, {
            status: 200,
            headers: saved.headers,
          });
        }
        if (alteration === "signature")
          responseHeaders.set("X-Bridge-Response-Signature", "0".repeat(64));
        if (alteration === "unsigned")
          responseHeaders.delete("X-Bridge-Response-Signature");
        return new Response(
          alteration === "body"
            ? '{"leaseId":"00000000-0000-0000-0000-000000000000"}'
            : bytes,
          {
            status: alteration === "status" ? 201 : response.status,
            headers: responseHeaders,
          },
        );
      },
    });
    const guard = createConnectorOwnerGuard({
      verifyOwner: async () => "101",
      leases: client,
    });
    try {
      if (alteration === "replay") await client.acquire("102", "telegram_auth");
      await assert.rejects(
        guard.withGameSessionLease(
          "verified",
          "user=%7B%22id%22%3A101%7D",
          () => assert.fail("must not send game request"),
        ),
        { code: "bridge_unavailable" },
      );
      assert.equal(storage.connectorLeases.pending("101")[0].phase, "prepared");
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
