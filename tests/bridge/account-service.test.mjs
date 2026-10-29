import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import { createBridgeDeviceService } from "../../scripts/bridge/device-service.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";

function fixture(readProfile, readGame, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-account-"));
  let storage = createBridgeStorage({ directory: dir });
  const devices = createBridgeDeviceService({ registry: storage.registry });
  const pair = (owner) =>
    devices.redeemInvitation(devices.issueInvitation(owner).invitation);
  const service = createBridgeAccountService({
    accounts: storage.accounts,
    devices,
    registry: storage.registry,
    readProfile,
    ...(readGame ? { readGame } : {}),
    ...extra,
  });
  return {
    dir,
    storage,
    devices,
    pair,
    service,
    reopen() {
      devices.close();
      storage.close();
      storage = createBridgeStorage({ directory: dir });
      return storage;
    },
    close() {
      try {
        storage.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
const goodProfile = async ({ validateTunnel }) => {
  assert.equal(validateTunnel(), true);
  return { status: 200, body: Buffer.from('{"playerId":42,"telegramId":101}') };
};

test("profile diagnostics distinguish an offline device from an ambiguous transport failure", async () => {
  let code = "bridge_offline";
  const f = fixture(async () => {
    throw Object.assign(new Error("private details"), { code });
  });
  try {
    f.pair("101");
    await assert.rejects(f.service.bind("101", "Bearer token"), {
      code: "device_offline",
    });
    code = "tls_failed";
    await assert.rejects(f.service.bind("101", "Bearer token"), {
      code: "bridge_unavailable",
    });
  } finally {
    f.devices.close();
    f.close();
  }
});

test("queued mutation requires a matching live one-use permission", async () => {
  const gate = createQueueActionGate();
  let sent = 0;
  const f = fixture(goodProfile, null, {
    queueActionGate: gate,
    sendAction: async ({ validateTunnel }) => {
      if (!validateTunnel()) throw new Error("not admitted");
      sent++;
      return { status: 200, body: Buffer.from("{}") };
    },
  });
  const job = {
    id: "test-job-1",
    status: "running",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  };
  const path = "/api/friends/requests/42/accept";
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    await assert.rejects(f.service.send("101", "POST", path), {
      code: "bridge_unavailable",
    });
    await gate.run(
      job,
      false,
      "Bearer private-test-token",
      async () => {
        assert.equal((await f.service.send("101", "POST", path)).status, 200);
        await assert.rejects(f.service.send("101", "POST", path), {
          code: "bridge_unavailable",
        });
      },
      () => true,
    );
    await gate.run(
      job,
      true,
      "Bearer private-test-token",
      async () => {
        await assert.rejects(f.service.send("101", "POST", path), {
          code: "bridge_unavailable",
        });
      },
      () => true,
    );
    assert.equal(sent, 1);
  } finally {
    f.devices.close();
    f.close();
  }
});

test("work-view method and body reach the bound device transport", async () => {
  const body = JSON.stringify({ workId: 7, locale: "ru" });
  const f = fixture(goodProfile, async (request) => {
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/api/works/open");
    assert.equal(request.body, body);
    assert.equal(request.validateTunnel(), true);
    return { status: 200, body: Buffer.from("{}") };
  });
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    assert.equal(
      (await f.service.read("101", "/api/works/open", { method: "POST", body }))
        .status,
      200,
    );
  } finally {
    f.devices.close();
    f.close();
  }
});

test("game reads use the stored account and reject a revoked device", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(
    goodProfile,
    async ({ authorization, path, validateTunnel }) => {
      assert.equal(authorization, "Bearer private-test-token");
      assert.equal(path, "/api/friends?limit=2");
      assert.equal(validateTunnel(), true);
      return pending;
    },
  );
  try {
    const device = f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    const read = f.service.read("101", "/api/friends?limit=2");
    f.devices.revoke("101", device.deviceId);
    release({ status: 200, body: Buffer.from("[]") });
    await assert.rejects(read, { code: "device_changed" });
  } finally {
    f.devices.close();
    f.close();
  }
});

test("binds verified profile, encrypts token, survives restart and exposes only status", async () => {
  const f = fixture(goodProfile);
  try {
    f.pair("101");
    assert.equal(f.service.status("101"), "not_configured");
    assert.deepEqual(await f.service.bind("101", "Bearer private-test-token"), {
      status: "connected",
    });
    assert.equal(
      readFileSync(join(f.dir, "devices.sqlite")).includes(
        Buffer.from("private-test-token"),
      ),
      false,
    );
    assert.equal(f.service.status("101"), "saved");
    const reopened = f.reopen();
    assert.deepEqual(reopened.accounts.read("101"), {
      playerId: "42",
      authorization: "Bearer private-test-token",
      revision: 1,
    });
    assert.equal(reopened.accounts.read("102"), null);
  } finally {
    f.close();
  }
});

test("rejects ownership conflicts, different player and stale revision", async () => {
  const f = fixture(async ({ authorization, validateTunnel }) => {
    assert.equal(validateTunnel(), true);
    return {
      status: 200,
      body: Buffer.from(
        JSON.stringify({
          playerId: 42,
          telegramId: authorization === "Bearer token-two" ? 102 : 101,
        }),
      ),
    };
  });
  try {
    const device = f.pair("101");
    await f.service.bind("101", "Bearer token-one");
    f.pair("102");
    await assert.rejects(f.service.bind("102", "Bearer token-two"), {
      code: "account_already_bound",
    });
    assert.throws(
      () =>
        f.storage.accounts.saveVerified({
          owner: "101",
          playerId: "43",
          authorization: "Bearer test",
          expectedRevision: 1,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "account_mismatch" },
    );
    assert.throws(
      () =>
        f.storage.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer test",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "binding_changed" },
    );
    assert.equal(
      f.storage.accounts.read("101").authorization,
      "Bearer token-one",
    );
  } finally {
    f.devices.close();
    f.close();
  }
});

test("revocation during profile read prevents credential persistence", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(() => pending);
  try {
    const device = f.pair("101");
    const binding = f.service.bind("101", "Bearer private-test-token");
    f.devices.revoke("101", device.deviceId);
    release({
      status: 200,
      body: Buffer.from('{"playerId":42,"telegramId":101}'),
    });
    await assert.rejects(binding, { code: "device_changed" });
    assert.equal(f.storage.accounts.read("101"), null);
  } finally {
    f.devices.close();
    f.close();
  }
});

test("invalid token, offline bridge and malformed profile leave no saved credential", async () => {
  const f = fixture(async () => {
    throw new Error("offline");
  });
  try {
    f.pair("101");
    await assert.rejects(f.service.bind("101", "Bearer secret"), {
      code: "bridge_unavailable",
    });
    await assert.rejects(f.service.bind("101", "Bearer bad\r\nheader"), {
      code: "invalid_game_token",
    });
    const bad = createBridgeAccountService({
      accounts: f.storage.accounts,
      devices: f.devices,
      registry: f.storage.registry,
      readProfile: async () => ({
        status: 200,
        body: Buffer.from('{"playerId":0}'),
      }),
    });
    await assert.rejects(bad.bind("101", "Bearer secret"), {
      code: "profile_invalid",
    });
    assert.equal(f.storage.accounts.read("101"), null);
  } finally {
    f.devices.close();
    f.close();
  }
});

test("tampered ciphertext is rejected instead of returning a token", async () => {
  const f = fixture(goodProfile);
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    const db = new DatabaseSync(join(f.dir, "devices.sqlite"));
    try {
      db.exec("UPDATE mobile_bridge_accounts SET ciphertext = x'00'");
    } finally {
      db.close();
    }
    assert.throws(() => f.storage.accounts.read("101"), {
      code: "account_storage_corrupt",
    });
  } finally {
    f.devices.close();
    f.close();
  }
});

test("profile is owner-scoped, strips secrets, and detects changed game identity", async () => {
  let playerId = 42;
  const f = fixture(async () => ({
    status: 200,
    body: Buffer.from(
      JSON.stringify({
        playerId,
        telegramId: 101,
        nickname: "fake",
        accessToken: "hidden",
        nested: { secretValue: "hidden", value: 1 },
      }),
    ),
  }));
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    assert.deepEqual(await f.service.profile("101"), {
      profile: {
        playerId: 42,
        telegramId: 101,
        nickname: "fake",
        nested: { value: 1 },
      },
    });
    await assert.rejects(f.service.profile("102"), {
      code: "account_not_configured",
    });
    playerId = 43;
    await assert.rejects(f.service.profile("101"), {
      code: "account_mismatch",
    });
  } finally {
    f.devices.close();
    f.close();
  }
});

test("saved session verification distinguishes an expired token from an offline bridge", async () => {
  let outcome = "valid";
  const f = fixture(async () => {
    if (outcome === "offline") throw new Error("disconnected");
    if (outcome === "expired") return { status: 401, body: Buffer.alloc(0) };
    return {
      status: 200,
      body: Buffer.from('{"playerId":42,"telegramId":101}'),
    };
  });
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer private-test-token");
    outcome = "expired";
    await assert.rejects(f.service.profile("101"), {
      code: "invalid_game_token",
    });
    outcome = "offline";
    await assert.rejects(f.service.profile("101"), {
      code: "bridge_unavailable",
    });
    assert.equal(f.service.status("101"), "saved");
  } finally {
    f.devices.close();
    f.close();
  }
});

test("profile request does not return a result after token changes", async () => {
  let release;
  let delayed = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = fixture(() =>
    delayed ? pending : goodProfile({ validateTunnel: () => true }),
  );
  try {
    const device = f.pair("101");
    await f.service.bind("101", "Bearer token-one");
    delayed = true;
    const inFlight = f.service.profile("101");
    f.storage.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer token-two",
      expectedRevision: 1,
      deviceId: device.deviceId,
      generation: 1,
    });
    release({
      status: 200,
      body: Buffer.from('{"playerId":42,"telegramId":101}'),
    });
    await assert.rejects(inFlight, { code: "binding_changed" });
  } finally {
    f.devices.close();
    f.close();
  }
});

test("verified player resolves to a durable bridge-only route without default direct", async () => {
  const f = fixture(goodProfile);
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer token-one");
    assert.deepEqual(f.storage.accounts.resolveVerifiedPlayer("42"), {
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
    });
    assert.equal(f.storage.accounts.resolveVerifiedPlayer("43"), null);
    await f.service.bind("101", "Bearer token-two");
    assert.equal(f.storage.accounts.resolveVerifiedPlayer("42").epoch, 2);
    const reopened = f.reopen();
    assert.deepEqual(reopened.accounts.resolveVerifiedPlayer("42"), {
      policy: "bridge_required",
      owner: "101",
      epoch: 2,
    });
  } finally {
    f.close();
  }
});

test("old credential remains bridge-scoped but is never accepted as current", async () => {
  const f = fixture(goodProfile);
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer token-one");
    assert.deepEqual(f.storage.accounts.resolveCredential("Bearer token-one"), {
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    });
    await f.service.bind("101", "Bearer token-two");
    assert.deepEqual(f.storage.accounts.resolveCredential("Bearer token-one"), {
      policy: "bridge_required",
      owner: "101",
      epoch: 2,
      credentialCurrent: false,
    });
    assert.equal(f.storage.accounts.resolveCredential("Bearer unknown"), null);
    const reopened = f.reopen();
    assert.equal(
      reopened.accounts.resolveCredential("Bearer token-one").credentialCurrent,
      false,
    );
    assert.equal(
      reopened.accounts.resolveCredential("Bearer token-two").credentialCurrent,
      true,
    );
  } finally {
    f.close();
  }
});

test("tampered credential ownership fails closed", async () => {
  const f = fixture(goodProfile);
  try {
    f.pair("101");
    await f.service.bind("101", "Bearer token-one");
    const db = new DatabaseSync(join(f.dir, "devices.sqlite"));
    try {
      db.exec(
        "UPDATE mobile_bridge_credential_aliases SET owner_key = 'tampered'",
      );
    } finally {
      db.close();
    }
    assert.throws(
      () => f.storage.accounts.resolveCredential("Bearer token-one"),
      { code: "account_storage_corrupt" },
    );
  } finally {
    f.devices.close();
    f.close();
  }
});

test("signed Telegram owner must match the game profile", async () => {
  const f = fixture(async () => ({
    status: 200,
    body: Buffer.from('{"playerId":42,"telegramId":102}'),
  }));
  try {
    f.pair("101");
    await assert.rejects(f.service.bind("101", "Bearer other-owners-token"), {
      code: "account_mismatch",
    });
    assert.equal(f.storage.accounts.read("101"), null);
  } finally {
    f.devices.close();
    f.close();
  }
});

test("binding and subsequent login reads use one game profile request", async () => {
  const { createAccountSnapshots } =
    await import("../../scripts/account/snapshots.mjs");
  const { createBridgeAwareAccountFetch } =
    await import("../../scripts/bridge/bridge-aware-fetch.mjs");
  let calls = 0;
  const f = fixture(async (args) => {
    calls++;
    return goodProfile(args);
  });
  const records = new Map();
  const snapshots = createAccountSnapshots({
    store: {
      readSnapshots: () => [...records.values()],
      writeSnapshot: (id, value) => records.set(id, structuredClone(value)),
      list: () => [],
    },
  });
  f.service.setProfileObserver((authorization, profile) =>
    snapshots.saveBridgeProfile(authorization, profile),
  );
  const transport = createBridgeAwareAccountFetch({
    snapshots,
    accounts: f.storage.accounts,
    directRoutes: {
      resolve: () => null,
      registerVerifiedDirect() {},
      withDirectLease() {},
    },
    accountService: f.service,
  });
  try {
    f.pair("101");
    const authorization = "Bearer private-test-token";
    await f.service.bind("101", authorization);
    for (let i = 0; i < 3; i++) {
      const response = await transport.fetch(
        "https://cargohustle.online/api/me",
        { headers: { Authorization: authorization } },
      );
      assert.equal((await response.json()).playerId, 42);
    }
    assert.equal(calls, 1);
    const refreshed = await transport.fetch(
      "https://cargohustle.online/api/me",
      {
        headers: {
          Authorization: authorization,
          "X-Madhouse-Snapshot-Refresh": "live",
        },
      },
    );
    assert.equal((await refreshed.json()).playerId, 42);
    assert.equal(calls, 2);
  } finally {
    f.devices.close();
    f.close();
  }
});
