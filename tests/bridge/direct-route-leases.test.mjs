import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import { createGameRouter } from "../../scripts/bridge/game-router.mjs";

const url = "https://cargohustle.online/api/me";

test("owner-scoped direct activity fences a different player of the same owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-owner-direct-"));
  const store = createBridgeStorage({ directory });
  try {
    store.directRoutes.registerVerifiedDirect("42");
    const device = store.registry.redeemInvitation(
      store.registry.issueInvitation("101").invitation,
    );
    const otherDevice = store.registry.redeemInvitation(
      store.registry.issueInvitation("102").invitation,
    );
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = store.directRoutes.withDirectLease(
      { playerId: "42", owner: "101" },
      1,
      async (mark) => {
        mark();
        await pending;
        return true;
      },
    );
    const bind = (owner, playerId, selected) =>
      store.accounts.saveVerified({
        owner,
        playerId,
        authorization: `Bearer token-${owner}`,
        expectedRevision: 0,
        deviceId: selected.deviceId,
        generation: 1,
      });
    assert.throws(() => bind("101", "43", device), {
      code: "direct_requests_in_flight",
    });
    assert.deepEqual(bind("102", "44", otherDevice), { revision: 1 });
    release();
    await request;
    assert.deepEqual(bind("101", "43", device), { revision: 1 });
    assert.equal(
      store.directRoutes.resolve({ playerId: "42", owner: "101" }),
      null,
    );
    assert.equal(store.directRoutes.resolve({ playerId: "42" }), null);
    await assert.rejects(
      store.directRoutes.withDirectLease(
        { playerId: "42", owner: "101" },
        1,
        () => assert.fail("must not dispatch"),
      ),
      { code: "bridge_route_required" },
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an ownerless legacy request conservatively fences bridge binding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-legacy-direct-"));
  const store = createBridgeStorage({ directory });
  try {
    store.directRoutes.registerVerifiedDirect("42");
    const device = store.registry.redeemInvitation(
      store.registry.issueInvitation("101").invitation,
    );
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = store.directRoutes.withDirectLease(
      { playerId: "42" },
      1,
      async (mark) => {
        mark();
        await pending;
      },
    );
    const bind = () =>
      store.accounts.saveVerified({
        owner: "101",
        playerId: "43",
        authorization: "Bearer token",
        expectedRevision: 0,
        deviceId: device.deviceId,
        generation: 1,
      });
    assert.throws(bind, { code: "direct_requests_in_flight" });
    release();
    await request;
    assert.deepEqual(bind(), { revision: 1 });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge activation waits for direct response drain across storage connections", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  const first = createBridgeStorage({ directory });
  const second = createBridgeStorage({ directory });
  try {
    const identity = { playerId: "42" };
    first.directRoutes.registerVerifiedDirect("42");
    const device = second.registry.redeemInvitation(
      second.registry.issueInvitation("101").invitation,
    );
    let finish;
    let started;
    const start = new Promise((resolve) => {
      started = resolve;
    });
    const body = new ReadableStream({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        };
      },
    });
    const router = createGameRouter({
      resolveRoute: first.directRoutes.resolve,
      withDirectLease: first.directRoutes.withDirectLease,
      directFetch: async () => {
        started();
        return new Response(body);
      },
      bridgeProfile: () => assert.fail("unexpected bridge"),
    });
    const direct = router.fetchGame({ url, verifiedIdentity: identity });
    await start;
    const save = () =>
      second.accounts.saveVerified({
        owner: "101",
        playerId: "42",
        authorization: "Bearer token",
        expectedRevision: 0,
        deviceId: device.deviceId,
        generation: 1,
      });
    assert.throws(save, { code: "direct_requests_in_flight" });
    finish();
    assert.equal(await (await direct).text(), "done");
    assert.deepEqual(save(), { revision: 1 });
    assert.equal(
      first.directRoutes.resolve(identity).policy,
      "bridge_required",
    );
    await assert.rejects(
      first.directRoutes.withDirectLease(identity, 1, () =>
        assert.fail("must not dispatch"),
      ),
      { code: "bridge_route_required" },
    );
  } finally {
    second.close();
    first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uncertain dispatched request survives restart and blocks bridge activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  let storage = createBridgeStorage({ directory });
  try {
    const identity = { playerId: "42" };
    storage.directRoutes.registerVerifiedDirect("42");
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    await assert.rejects(
      storage.directRoutes.withDirectLease(identity, 1, (mark) => {
        mark();
        throw new Error("unknown outcome");
      }),
      { message: "unknown outcome" },
    );
    const pendingBefore = storage.directRoutes.pending("42");
    assert.equal(pendingBefore.length, 1);
    assert.equal(pendingBefore[0].phase, "dispatched");
    assert.equal(pendingBefore[0].effect, "unknown");
    assert.deepEqual(storage.directRoutes.pending("43"), []);
    storage.close();
    storage = createBridgeStorage({ directory });
    assert.deepEqual(storage.directRoutes.pending("42"), pendingBefore);
    assert.throws(
      () =>
        storage.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer token",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "direct_requests_in_flight" },
    );
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pre-dispatch failure releases the lease", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  const storage = createBridgeStorage({ directory });
  try {
    storage.directRoutes.registerVerifiedDirect("42");
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    await assert.rejects(
      storage.directRoutes.withDirectLease({ playerId: "42" }, 1, () => {
        throw new Error("before dispatch");
      }),
      { message: "before dispatch" },
    );
    assert.deepEqual(
      storage.accounts.saveVerified({
        owner: "101",
        playerId: "42",
        authorization: "Bearer token",
        expectedRevision: 0,
        deviceId: device.deviceId,
        generation: 1,
      }),
      { revision: 1 },
    );
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing account record never reactivates a previous direct route", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  const storage = createBridgeStorage({ directory });
  try {
    storage.directRoutes.registerVerifiedDirect("42");
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    storage.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer token",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    const other = new DatabaseSync(join(directory, "devices.sqlite"));
    try {
      other.exec("DELETE FROM mobile_bridge_accounts");
    } finally {
      other.close();
    }
    assert.equal(storage.directRoutes.resolve({ playerId: "42" }), null);
    assert.throws(() => storage.directRoutes.registerVerifiedDirect("42"), {
      code: "bridge_route_required",
    });
    await assert.rejects(
      storage.directRoutes.withDirectLease({ playerId: "42" }, 1, () =>
        assert.fail("unexpected network"),
      ),
      { code: "bridge_route_required" },
    );
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a completed stale display read releases the lease and preserves its metadata", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  const storage = createBridgeStorage({ directory });
  try {
    storage.directRoutes.registerVerifiedDirect("42");
    const router = createGameRouter({
      resolveRoute: storage.directRoutes.resolve,
      withDirectLease: storage.directRoutes.withDirectLease,
      directFetch: async () =>
        new Response('{"playerId":42}', {
          headers: { "X-Madhouse-Snapshot": "stale" },
        }),
      bridgeProfile: () => assert.fail("unexpected bridge"),
    });
    const response = await router.fetchGame({
      url,
      verifiedIdentity: { playerId: "42" },
    });
    assert.equal(response.headers.get("X-Madhouse-Snapshot"), "stale");
    const pending = storage.directRoutes.pending("42");
    assert.equal(pending.length, 0);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an uncertain mutation remains fenced after an error response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-"));
  const storage = createBridgeStorage({ directory });
  try {
    storage.directRoutes.registerVerifiedDirect("42");
    const router = createGameRouter({
      resolveRoute: storage.directRoutes.resolve,
      withDirectLease: storage.directRoutes.withDirectLease,
      directFetch: async () => new Response(null, { status: 503 }),
      bridgeProfile: () => assert.fail("unexpected bridge"),
    });
    await assert.rejects(
      router.fetchGame({
        url,
        init: { method: "POST" },
        verifiedIdentity: { playerId: "42" },
      }),
      { code: "direct_result_uncertain" },
    );
    assert.equal(storage.directRoutes.pending("42")[0].effect, "mutation");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
