import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConnectorApi } from "../../connector/game-auth-api.js";
import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import { createConnectorOwnerGuard } from "../../scripts/bridge/connector-owner-guard.mjs";
import {
  createConnectorLeaseIpcClient,
  createConnectorLeaseIpcHandler,
} from "../../scripts/bridge/connector-lease-ipc.mjs";
import {
  createDirectVpsConnector,
  createDirectVpsOwner,
} from "../../scripts/game/direct-vps.mjs";

test("an independent owner bootstraps through signed IPC while an unrelated bridge attempt remains fenced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bootstrap-integration-"));
  const storage = createBridgeStorage({ directory: join(directory, "bridge") });
  const journal = createAutomationStateStore({
    directory: join(directory, "automation"),
  });
  journal.createBridgeAttempt({
    id: "00000000-0000-4000-8000-000000000001",
    playerId: "42",
    operationId: "uncertain-job",
    deviceId: "00000000-0000-4000-8000-000000000002",
    bindingRevision: 1,
    deviceGeneration: 1,
    action: "mutation",
    phase: "uncertain",
    createdAt: 1,
    updatedAt: 1,
  });
  const leases = storage.connectorLeases;
  const key = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases,
    directCredentials: storage.directCredentials,
    consumeNonce: storage.consumeConnectorNonce,
    key,
  });
  const leaseClient = createConnectorLeaseIpcClient({
    endpoint: "http://wiki:9094/internal/bridge/connector-lease",
    key,
    fetcher: (url, init) => handler(new Request(url, init), true),
  });
  const guard = createConnectorOwnerGuard({
    verifyOwner: async (proof) =>
      proof === "signed-owner-102"
        ? "102"
        : proof === "signed-owner-104"
          ? "104"
          : null,
    leases: leaseClient,
  });
  const calls = [];
  let profileFailure = false;
  const direct = createDirectVpsOwner({
    env: {
      MADHOUSE_GAME_EXECUTOR_KEY: "x".repeat(64),
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_QUEUE_WAIT_MS: "100",
    },
    requireBridgeJournal: true,
    bootstrapPolicy: {
      canClaim: leases.canClaimStep,
      claim: leases.claimStep,
      complete: leases.completeStep,
    },
    fetcher: async (url) => {
      calls.push(new URL(url).pathname);
      return url.endsWith("/api/auth/telegram")
        ? Response.json({ accessToken: "header.payload.signature" })
        : profileFailure
          ? new Response("{}", { status: 503 })
          : Response.json({ telegramId: 102, playerId: 43 });
    },
  });
  direct.boundary.installBridgeStore(journal);
  direct.server.listen(0, "127.0.0.1");
  await once(direct.server, "listening");
  const port = direct.server.address().port;
  const fetcher = createDirectVpsConnector({
    env: {
      MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://wiki:9095",
      MADHOUSE_GAME_EXECUTOR_KEY: "x".repeat(64),
    },
    fetcher: (_url, init) =>
      fetch(`http://127.0.0.1:${port}/internal/game/direct`, init),
  });
  const api = createConnectorApi({
    appParams: async () => ({ apiId: 123, apiHash: "a".repeat(32) }),
    wikiOrigins: [],
    withGameSessionLease: guard.withGameSessionLease,
    fetcher,
  });
  try {
    await assert.rejects(
      fetcher("https://cargohustle.online/api/me", {
        headers: { authorization: "Bearer unverified" },
      }),
      (error) => error.notDispatched === true,
    );
    const authorization = "Bearer unverified";
    await assert.rejects(
      fetcher("https://cargohustle.online/api/me", {
        headers: { authorization },
        gameBootstrap: {
          owner: "102",
          leaseId: "00000000-0000-4000-8000-000000000003",
          step: "profile",
          attempt: 1,
          credentialDigest: createHash("sha256")
            .update(authorization)
            .digest("hex"),
        },
      }),
      (error) => error.notDispatched === true,
    );
    assert.deepEqual(calls, []);
    const initData = new URLSearchParams({
      hash: "a".repeat(64),
      auth_date: "1",
      user: JSON.stringify({ id: 102 }),
    }).toString();
    const response = await api(
      new Request("https://connect.example/api/game-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ initData, wikiInitData: "signed-owner-102" }),
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["/api/auth/telegram", "/api/me"]);
    profileFailure = true;
    const failedInitData = new URLSearchParams({
      hash: "a".repeat(64),
      auth_date: "1",
      user: JSON.stringify({ id: 104 }),
    }).toString();
    const failed = await api(
      new Request("https://connect.example/api/game-session", {
        method: "POST",
        headers: {
          Origin: "https://connect.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          initData: failedInitData,
          wikiInitData: "signed-owner-104",
        }),
      }),
    );
    assert.equal(failed.status, 502);
    assert.deepEqual(leases.pending("104"), []);
    assert.deepEqual(calls, [
      "/api/auth/telegram",
      "/api/me",
      "/api/auth/telegram",
      "/api/me",
    ]);
    const retryAuthorization = "Bearer retry-profile";
    const retryDigest = createHash("sha256")
      .update(retryAuthorization)
      .digest("hex");
    await assert.rejects(
      guard.withOwnerLease(
        "105",
        "session_verify",
        async (_register, context) => {
          for (let attempt = 1; attempt <= 3; attempt++) {
            const result = await fetcher("https://cargohustle.online/api/me", {
              headers: { authorization: retryAuthorization },
              gameAttempt: attempt,
              gameBootstrap: {
                owner: context.owner,
                leaseId: context.leaseId,
                step: "profile",
                attempt,
                credentialDigest: retryDigest,
              },
            });
            assert.equal(result.status, 503);
          }
          throw new Error("game_unavailable");
        },
      ),
      /game_unavailable/,
    );
    assert.deepEqual(leases.pending("105"), []);
    assert.equal(journal.readActiveBridgeAttempts().length, 1);
    assert.equal(direct.boundary.diagnostics().durableBlocks, 1);
    assert.deepEqual(leases.pending("102"), []);
    assert.equal(
      storage.directCredentials.resolve("Bearer header.payload.signature")
        ?.playerId,
      "43",
    );
    const quarantinedAuthorization = "Bearer quarantined";
    direct.boundary.bindVerified(quarantinedAuthorization, "42");
    const blockedLease = leases.acquire("103", "session_verify");
    leases.markDispatched("103", blockedLease);
    const blockedDigest = createHash("sha256")
      .update(quarantinedAuthorization)
      .digest("hex");
    await assert.rejects(
      fetcher("https://cargohustle.online/api/me", {
        headers: { authorization: quarantinedAuthorization },
        gameBootstrap: {
          owner: "103",
          leaseId: blockedLease,
          step: "profile",
          attempt: 1,
          credentialDigest: blockedDigest,
        },
      }),
      (error) => error.notDispatched === true,
    );
    assert.equal(
      leases.canClaimStep("103", blockedLease, "profile", 1, blockedDigest),
      true,
    );
    assert.deepEqual(calls, [
      "/api/auth/telegram",
      "/api/me",
      "/api/auth/telegram",
      "/api/me",
      "/api/me",
      "/api/me",
      "/api/me",
    ]);
  } finally {
    direct.boundary.close();
    direct.server.close();
    await once(direct.server, "close");
    journal.close();
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
