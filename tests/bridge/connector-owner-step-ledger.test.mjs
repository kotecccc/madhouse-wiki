import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-owner-step-ledger-"));
  const storage = createBridgeStorage({ directory });
  return {
    directory,
    storage,
    close() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const digest = "a".repeat(64);

test("telegram auth is one-shot and profile retries require a known retryable response", () => {
  const f = fixture();
  try {
    const leases = f.storage.connectorLeases;
    const lease = leases.acquire("101", "telegram_auth");
    assert.throws(() => leases.acquire("101", "telegram_auth"), {
      code: "owner_lease_in_flight",
    });
    leases.markDispatched("101", lease);

    assert.equal(
      leases.canClaimStep("101", lease, "telegram_auth", 1, null),
      true,
    );
    assert.equal(
      leases.claimStep("101", lease, "telegram_auth", 1, null),
      true,
    );
    assert.equal(
      leases.canClaimStep("101", lease, "telegram_auth", 1, null),
      false,
    );
    assert.throws(
      () => leases.claimStep("101", lease, "telegram_auth", 1, null),
      { code: "owner_lease_step_invalid" },
    );
    assert.throws(() => leases.bindCredential("101", lease, digest), {
      code: "owner_lease_step_invalid",
    });

    leases.completeStep("101", lease, "telegram_auth", 1, 201);
    leases.bindCredential("101", lease, digest);
    assert.equal(leases.canClaimStep("101", lease, "profile", 1, digest), true);
    leases.claimStep("101", lease, "profile", 1, digest);
    assert.equal(
      leases.canClaimStep("101", lease, "profile", 2, digest),
      false,
    );
    leases.completeStep("101", lease, "profile", 1, 503);
    assert.equal(leases.canClaimStep("101", lease, "profile", 2, digest), true);
    assert.equal(
      leases.canClaimStep("101", lease, "profile", 2, "b".repeat(64)),
      false,
    );
    leases.claimStep("101", lease, "profile", 2, digest);
    leases.completeStep("101", lease, "profile", 2, 500);
    leases.claimStep("101", lease, "profile", 3, digest);
    leases.completeStep("101", lease, "profile", 3, 504);
    assert.equal(leases.canRegisterProfile("101", lease, digest), false);
    assert.equal(
      leases.canClaimStep("101", lease, "profile", 4, digest),
      false,
    );
    assert.throws(() => leases.claimStep("101", lease, "profile", 4, digest), {
      code: "owner_lease_step_invalid",
    });

    assert.equal(
      leases.finish("101", lease, { definitelyFinished: true }),
      true,
    );
    assert.deepEqual(leases.pending("101"), []);
  } finally {
    f.close();
  }
});

test("unknown dispatch outcomes are never claimable again", () => {
  const f = fixture();
  try {
    const leases = f.storage.connectorLeases;
    const authLease = leases.acquire("101", "telegram_auth");
    leases.markDispatched("101", authLease);
    leases.claimStep("101", authLease, "telegram_auth", 1, null);
    assert.equal(
      leases.canClaimStep("101", authLease, "telegram_auth", 1, null),
      false,
    );
    assert.equal(
      leases.canClaimStep("101", authLease, "profile", 1, digest),
      false,
    );
    assert.throws(
      () => leases.claimStep("101", authLease, "telegram_auth", 1, null),
      { code: "owner_lease_step_invalid" },
    );

    const profileLease = leases.acquire("102", "session_verify");
    leases.markDispatched("102", profileLease);
    leases.claimStep("102", profileLease, "profile", 1, digest);
    assert.equal(
      leases.canClaimStep("102", profileLease, "profile", 2, digest),
      false,
    );
    assert.throws(
      () => leases.claimStep("102", profileLease, "profile", 2, digest),
      { code: "owner_lease_step_invalid" },
    );
  } finally {
    f.close();
  }
});

test("profile retry statuses are exact, terminal statuses cannot authorize registration, and legacy leases fail closed", () => {
  const f = fixture();
  try {
    const leases = f.storage.connectorLeases;
    const lease = leases.acquire("101", "session_verify");
    leases.markDispatched("101", lease);
    leases.claimStep("101", lease, "profile", 1, digest);
    leases.completeStep("101", lease, "profile", 1, 429);
    assert.equal(
      leases.canClaimStep("101", lease, "profile", 2, digest),
      false,
    );
    assert.throws(() => leases.claimStep("101", lease, "profile", 2, digest), {
      code: "owner_lease_step_invalid",
    });
    assert.throws(() => leases.completeStep("101", lease, "profile", 1, 600), {
      code: "owner_lease_step_invalid",
    });

    const raw = new DatabaseSync(join(f.directory, "devices.sqlite"));
    try {
      const ownerKey = f.storage.registry.ownerKey("103");
      raw
        .prepare(
          "INSERT INTO mobile_bridge_owner_leases (lease_id, owner_key, phase, operation, created_at) VALUES (?, ?, 'dispatched', 'telegram_auth', 1)",
        )
        .run("legacy-step-ledger-lease", ownerKey);
    } finally {
      raw.close();
    }
    assert.equal(
      leases.canClaimStep(
        "103",
        "legacy-step-ledger-lease",
        "telegram_auth",
        1,
        null,
      ),
      false,
    );
    assert.throws(
      () =>
        leases.claimStep(
          "103",
          "legacy-step-ledger-lease",
          "telegram_auth",
          1,
          null,
        ),
      { code: "owner_lease_step_invalid" },
    );
  } finally {
    f.close();
  }
});

test("session verification binds the credential digest on its first profile claim", () => {
  const f = fixture();
  try {
    const leases = f.storage.connectorLeases;
    const lease = leases.acquire("101", "session_verify");
    leases.markDispatched("101", lease);
    assert.equal(leases.canClaimStep("101", lease, "profile", 1, digest), true);
    leases.claimStep("101", lease, "profile", 1, digest);
    assert.equal(
      leases.canClaimStep("101", lease, "profile", 2, "b".repeat(64)),
      false,
    );
    leases.completeStep("101", lease, "profile", 1, 502);
    assert.equal(leases.canClaimStep("101", lease, "profile", 2, digest), true);
    assert.equal(leases.canRegisterProfile("101", lease, digest), false);
    leases.claimStep("101", lease, "profile", 2, digest);
    leases.completeStep("101", lease, "profile", 2, 200);
    assert.equal(leases.canRegisterProfile("101", lease, digest), true);
  } finally {
    f.close();
  }
});

test("only a known non-2xx Telegram profile result allows lease completion", () => {
  const f = fixture();
  try {
    const leases = f.storage.connectorLeases;
    const unknownAuth = leases.acquire("101", "telegram_auth");
    leases.markDispatched("101", unknownAuth);
    leases.claimStep("101", unknownAuth, "telegram_auth", 1, null);
    assert.equal(
      leases.canFinishKnownProfileFailure("101", unknownAuth),
      false,
    );

    const failedProfile = leases.acquire("102", "telegram_auth");
    leases.markDispatched("102", failedProfile);
    leases.claimStep("102", failedProfile, "telegram_auth", 1, null);
    leases.completeStep("102", failedProfile, "telegram_auth", 1, 200);
    leases.bindCredential("102", failedProfile, digest);
    leases.claimStep("102", failedProfile, "profile", 1, digest);
    assert.equal(
      leases.canFinishKnownProfileFailure("102", failedProfile),
      false,
    );
    leases.completeStep("102", failedProfile, "profile", 1, 503);
    assert.equal(
      leases.canFinishKnownProfileFailure("102", failedProfile),
      true,
    );
    assert.equal(leases.finishKnownProfileFailure("102", failedProfile), true);
    assert.deepEqual(leases.pending("102"), []);

    const retryInFlight = leases.acquire("105", "telegram_auth");
    leases.markDispatched("105", retryInFlight);
    leases.claimStep("105", retryInFlight, "telegram_auth", 1, null);
    leases.completeStep("105", retryInFlight, "telegram_auth", 1, 200);
    leases.bindCredential("105", retryInFlight, "c".repeat(64));
    leases.claimStep("105", retryInFlight, "profile", 1, "c".repeat(64));
    leases.completeStep("105", retryInFlight, "profile", 1, 503);
    assert.equal(
      leases.canFinishKnownProfileFailure("105", retryInFlight),
      true,
    );
    leases.claimStep("105", retryInFlight, "profile", 2, "c".repeat(64));
    assert.equal(
      leases.canFinishKnownProfileFailure("105", retryInFlight),
      false,
    );
    assert.equal(leases.finishKnownProfileFailure("105", retryInFlight), false);
    assert.equal(leases.pending("105").length, 1);

    const successfulProfile = leases.acquire("103", "telegram_auth");
    leases.markDispatched("103", successfulProfile);
    leases.claimStep("103", successfulProfile, "telegram_auth", 1, null);
    leases.completeStep("103", successfulProfile, "telegram_auth", 1, 200);
    leases.bindCredential("103", successfulProfile, "b".repeat(64));
    leases.claimStep("103", successfulProfile, "profile", 1, "b".repeat(64));
    leases.completeStep("103", successfulProfile, "profile", 1, 200);
    assert.equal(
      leases.canFinishKnownProfileFailure("103", successfulProfile),
      false,
    );

    const sessionVerify = leases.acquire("104", "session_verify");
    leases.markDispatched("104", sessionVerify);
    leases.claimStep("104", sessionVerify, "profile", 1, digest);
    leases.completeStep("104", sessionVerify, "profile", 1, 503);
    assert.equal(
      leases.canFinishKnownProfileFailure("104", sessionVerify),
      false,
    );
  } finally {
    f.close();
  }
});
