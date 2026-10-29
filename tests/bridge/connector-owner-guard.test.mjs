import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import { createConnectorOwnerGuard } from "../../scripts/bridge/connector-owner-guard.mjs";

test("guard permits only verified owner and holds the lease through direct exchange", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connector-guard-"));
  const store = createBridgeStorage({ directory });
  const guard = createConnectorOwnerGuard({
    verifyOwner: async (proof) => (proof === "verified" ? "101" : null),
    leases: store.connectorLeases,
  });
  try {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    const request = guard.withGameSessionLease(
      "verified",
      "user=%7B%22id%22%3A101%7D",
      async () => {
        await wait;
        return new Response("ok");
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.connectorLeases.pending("101")[0].phase, "dispatched");
    release();
    assert.equal((await request).status, 200);
    assert.deepEqual(store.connectorLeases.pending("101"), []);
    await assert.rejects(
      guard.withGameSessionLease("forged", "user=%7B%22id%22%3A101%7D", () =>
        assert.fail("unexpected network"),
      ),
      { message: "invalid_wiki_identity" },
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown outcome keeps an owner-scoped lease through restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connector-guard-"));
  let store = createBridgeStorage({ directory });
  try {
    const guard = createConnectorOwnerGuard({
      verifyOwner: async () => "101",
      leases: store.connectorLeases,
    });
    await assert.rejects(
      guard.withGameSessionLease(
        "verified",
        "user=%7B%22id%22%3A101%7D",
        () => {
          throw new Error("connection lost");
        },
      ),
    );
    store.close();
    store = createBridgeStorage({ directory });
    assert.equal(store.connectorLeases.pending("101").length, 1);
    assert.deepEqual(store.connectorLeases.pending("102"), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("game launch identity cannot differ from verified Wiki owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "connector-guard-"));
  const store = createBridgeStorage({ directory });
  const guard = createConnectorOwnerGuard({
    verifyOwner: async () => "101",
    leases: store.connectorLeases,
  });
  try {
    await assert.rejects(
      guard.withGameSessionLease("verified", "user=%7B%22id%22%3A102%7D", () =>
        assert.fail("unexpected direct request"),
      ),
      { message: "invalid_game_identity" },
    );
    assert.deepEqual(store.connectorLeases.pending("101"), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Connector preflights both identities and does not send bridge owners directly", async () => {
  const { createConnectorApi } =
    await import("../../connector/game-auth-api.js");
  const directory = mkdtempSync(join(tmpdir(), "connector-guard-"));
  const store = createBridgeStorage({ directory });
  const guard = createConnectorOwnerGuard({
    verifyOwner: async (proof) =>
      proof === "signed-101" ? "101" : proof === "signed-102" ? "102" : null,
    leases: {
      ...store.connectorLeases,
      registerVerified: (owner, leaseId, playerId, credentialDigest) =>
        store.directCredentials.register({
          owner,
          leaseId,
          playerId,
          credentialDigest,
        }),
    },
  });
  let calls = 0;
  const api = createConnectorApi({
    appParams: async () => ({ apiId: 123, apiHash: "a".repeat(32) }),
    wikiOrigins: [],
    withGameSessionLease: guard.withGameSessionLease,
    fetcher: async (url, init) => {
      calls += 1;
      const { owner, leaseId, step, attempt, credentialDigest } =
        init.gameBootstrap;
      store.connectorLeases.claimStep(
        owner,
        leaseId,
        step,
        attempt,
        credentialDigest,
      );
      const response = url.endsWith("/api/me")
        ? Response.json({ telegramId: 102, playerId: 43 })
        : new Response(
            JSON.stringify({ accessToken: "header.payload.signature" }),
          );
      store.connectorLeases.completeStep(
        owner,
        leaseId,
        step,
        attempt,
        response.status,
      );
      return response;
    },
  });
  const request = (body) =>
    new Request("https://connect.example/api/game-session", {
      method: "POST",
      headers: {
        Origin: "https://connect.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const gameInit = (id) =>
    new URLSearchParams({
      hash: "a".repeat(64),
      auth_date: "1",
      user: JSON.stringify({ id }),
    }).toString();
  try {
    assert.equal((await api(request({ initData: gameInit(101) }))).status, 400);
    assert.equal(
      (
        await api(
          request({ initData: gameInit(102), wikiInitData: "signed-101" }),
        )
      ).status,
      401,
    );
    const device = store.registry.redeemInvitation(
      store.registry.issueInvitation("101").invitation,
    );
    store.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer token",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    const blocked = await api(
      request({ initData: gameInit(101), wikiInitData: "signed-101" }),
    );
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, "bridge_route_required");
    assert.equal(calls, 0);
    const direct = await api(
      request({ initData: gameInit(102), wikiInitData: "signed-102" }),
    );
    assert.equal(direct.status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(store.connectorLeases.pending("102"), []);
    const config = await api(new Request("https://connect.example/api/config"));
    assert.equal((await config.json()).bridgePolicyRequired, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
