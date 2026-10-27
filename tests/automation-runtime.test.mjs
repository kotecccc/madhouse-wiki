import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAutomationRuntime,
  createRestoreOperationGuard,
} from "../scripts/automation/runtime.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

test("runtime WebSocket admission follows the complete release gate and still requires a device session", async () => {
  const commit = "a".repeat(40);
  const baseEnv = {
    MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
    MADHOUSE_RELEASE_SHA: commit,
    MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "1",
    MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: commit,
    MADHOUSE_BRIDGE_R0_RELEASE_SHA: commit,
    MADHOUSE_HOST_CONFIG_VERSION: "1",
    MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED: "1",
    MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED: "1",
  };
  for (const [override, expectedStatus] of [
    [{ MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "0" }, 404],
    [{ MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: "" }, 404],
    [{ MADHOUSE_HOST_CONFIG_VERSION: "0" }, 404],
    [{ MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED: "0" }, 404],
    [{ MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED: "0" }, 404],
    [{}, 401],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), "bridge-runtime-gate-"));
    let runtime;
    try {
      runtime = await createAutomationRuntime({
        env: {
          ...baseEnv,
          ...override,
          MADHOUSE_AUTOMATION_STATE_DIR: directory,
        },
      });
      let response = "";
      const socket = {
        end: (value) => {
          response = value;
        },
      };
      await runtime.bridgeUpgradeHandler(
        { method: "GET", url: "/bridge/control", headers: {} },
        socket,
        Buffer.alloc(0),
      );
      assert.match(response, new RegExp(`^HTTP/1.1 ${expectedStatus} `));
    } finally {
      runtime?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("restore guard denies unbound direct bootstrap when restore starts after route selection", () => {
  let guarded = false;
  const check = createRestoreOperationGuard({
    isRestoreGuardActive: () => guarded,
  });
  const request = {
    accountId: null,
    operation: { operationClass: "auth_issuance" },
    route: { authBootstrap: true },
  };
  assert.equal(check(request), true);
  guarded = true;
  assert.equal(check(request), false);
});

test("runtime HTTP reconciles a restored character checkpoint using only fake reads", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "automation-runtime-restore-read-"),
  );
  let runtime;
  const store = createAutomationStateStore({ directory });
  const credential = "Bearer fixture.payload.signature";
  const pending = {
    id: "fixture",
    stat: "madness",
    base: 20,
    dailyUsed: 0,
    resetAt: "2099-01-01T00:00:00Z",
    currency: "gold",
    balance: 1000,
    price: 10,
  };
  store.write("101", {
    credential,
    characterUpgrade: { profile: null, pending, run: null },
  });
  const otherCredential = "Bearer another.payload.signature";
  store.write("202", {
    credential: otherCredential,
    characterUpgrade: { profile: null, pending, run: null },
  });
  store.writeSnapshot("101", {
    schemaVersion: 1,
    playerId: "101",
    sections: {
      "/api/me": {
        updatedAt: 1,
        data: {
          playerId: 101,
          wallet: { gold: 990 },
          characterStats: { madness: { base: 21 } },
          characterStatsUpgrade: {
            resetAtUtc: "2099-01-01T00:00:00Z",
            madness: { dailyUsed: 1 },
          },
        },
      },
    },
    credentialHashes: [],
  });
  store.activateRestoreGuard({ activatedAt: 1000 });
  store.bindVerifiedGameAccount("54321", "101", 1001);
  store.bindVerifiedGameAccount("54322", "202", 1001);
  store.selectRoutePolicy("101", {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 0,
    updatedAt: 1002,
  });
  store.selectRoutePolicy("202", {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 0,
    updatedAt: 1002,
  });
  store.confirmRestoredAccount({
    ownerId: "54321",
    playerId: "101",
    verifiedAt: 1003,
  });
  store.close();
  const calls = [];
  let completeProfile = false;
  const fetcher = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method || "GET" });
    if (new URL(url).pathname !== "/api/me" || (init.method || "GET") !== "GET")
      throw new Error("unexpected_upstream");
    if (!completeProfile) return Response.json({ playerId: 101 });
    return Response.json({
      playerId: 101,
      wallet: { gold: 990, dollar: 0, pills: 0 },
      characterStats: { madness: { base: 21, total: 21 } },
      characterStatsUpgrade: {
        resetAtUtc: "2099-01-01T00:00:00Z",
        madness: {
          currency: "gold",
          costPerPoint: 10,
          nextCost: 10,
          maxCost: 10,
          dailyLimit: 3,
          dailyUsed: 1,
          dailyRemaining: 2,
        },
      },
    });
  };
  const request = (path, body) =>
    new Request(`http://localhost${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: credential,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  try {
    runtime = await createAutomationRuntime({
      env: { MADHOUSE_AUTOMATION_STATE_DIR: directory },
      fetcher,
    });
    const state = await runtime.handle(request("/api/automation/state"));
    assert.equal(state.status, 200);
    const initial = await state.json();
    assert.ok(initial.characterUpgrade.pending);
    async function refresh(version) {
      const ticketResponse = await runtime.handle(
        request("/api/automation/command-ticket", {
          command: "character.refresh",
          expectedVersion: version,
          args: {},
        }),
      );
      assert.equal(ticketResponse.status, 200);
      const ticket = await ticketResponse.json();
      const response = await runtime.handle(
        request("/api/automation/commands", {
          command: "character.refresh",
          id: ticket.id,
          admissionTicket: ticket.ticket,
          expectedVersion: ticket.intentVersion,
          args: {},
        }),
      );
      assert.equal(response.status, 200);
      return response.json();
    }
    const incomplete = await refresh(initial.version);
    assert.ok(incomplete.characterUpgrade.pending);
    completeProfile = true;
    const complete = await refresh(incomplete.version);
    assert.equal(complete.characterUpgrade.pending, null);
    const callsBeforeOther = calls.length;
    const otherState = await runtime.handle(
      new Request("http://localhost/api/automation/state", {
        headers: { authorization: otherCredential },
      }),
    );
    assert.equal(otherState.status, 409);
    assert.equal(calls.length, callsBeforeOther);
    const checkStore = createAutomationStateStore({ directory });
    try {
      assert.equal(checkStore.isRestoreRequired("101"), false);
      assert.equal(checkStore.isRestoreRequired("202"), true);
      assert.ok(checkStore.read("202").characterUpgrade.pending);
    } finally {
      checkStore.close();
    }
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(({ method }) => method === "GET"));
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
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

test("runtime arms the durable restore guard before starting restored actors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-runtime-restore-"));
  let runtime;
  const initial = createAutomationStateStore({ directory });
  initial.write("101", {
    credential: "Bearer saved.token.signature",
    auto: { enabled: true, phase: "between_battles" },
  });
  initial.close();
  const markerPath = join(directory, "restore-required");
  writeFileSync(
    markerPath,
    `${JSON.stringify({ schemaVersion: 1, createdAt: 1 })}\n`,
    { mode: 0o600 },
  );
  chmodSync(markerPath, 0o600);

  try {
    runtime = await createAutomationRuntime({
      env: { MADHOUSE_AUTOMATION_STATE_DIR: directory },
    });
    runtime.close();
    runtime = null;
    const restored = createAutomationStateStore({ directory });
    assert.equal(restored.isRestoreGuardActive(), true);
    assert.equal(restored.isRestoreRequired("101"), true);
    restored.close();
  } finally {
    runtime?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
