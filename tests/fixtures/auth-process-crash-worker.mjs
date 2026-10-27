import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createAuthCoordinator } from "../../scripts/account/auth-coordinator.mjs";
import { createGameCredentialStore } from "../../scripts/account/game-credential-store.mjs";
import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";
import { createFileBackedCredentialStorage } from "./file-backed-credential-storage.mjs";

const directory = process.env.AUTH_CRASH_DIRECTORY;
const markerPath = process.env.AUTH_CRASH_MARKER;
const activityPath = process.env.AUTH_CRASH_ACTIVITY;
const mode = process.env.AUTH_CRASH_MODE;
const ownerId = "7654321";
const playerId = "987654321";
const deviceId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000123";
const now = 1_798_000_000_100;
const accessToken = token();
let issueResponseReturned = false;
let verificationResponseReturned = false;

function token() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString(
    "base64url",
  );
  return `${header}.${payload}.signature`;
}

function recordActivity(value) {
  appendFileSync(activityPath, `${value}\n`, { mode: 0o600 });
}

function signalReady(value) {
  writeFileSync(markerPath, value, { mode: 0o600 });
  writeSync(1, `READY:${value}\n`);
}

function hold() {
  return new Promise(() => {});
}

if (
  !directory ||
  !markerPath ||
  !activityPath ||
  !process.env.AUTH_CRASH_ENCRYPTION_KEY ||
  !["after-response", "before-cas", "after-cas"].includes(mode)
)
  throw new Error("auth_crash_fixture_arguments_invalid");

const store = createAutomationStateStore({
  directory: join(directory, "wiki"),
});
store.bindVerifiedGameAccount(ownerId, playerId, now);
store.selectRoutePolicy(playerId, {
  policy: "bridge_required",
  activeDeviceId: deviceId,
  expectedRouteEpoch: 0,
  updatedAt: now + 1,
});

const credentialBacking = createFileBackedCredentialStorage(
  join(directory, "private"),
);
const durableCredentials = createGameCredentialStore({
  store: credentialBacking,
  encryptionKey: process.env.AUTH_CRASH_ENCRYPTION_KEY,
});
const credentialStore = {
  read: async (owner) => {
    if (mode === "before-cas" && verificationResponseReturned) {
      signalReady("verified-profile-before-private-cas");
      return hold();
    }
    return durableCredentials.read(owner);
  },
  compareAndSwap: async (request) => {
    const committed = await durableCredentials.compareAndSwap(request);
    if (mode === "after-cas") {
      recordActivity("credential-cas");
      signalReady("after-private-cas-before-sqlite-transition");
      return hold();
    }
    return committed;
  },
};

const readGameAuthRecovery = store.readGameAuthRecovery.bind(store);
let heldAfterResponse = false;
store.readGameAuthRecovery = (owner) => {
  const record = readGameAuthRecovery(owner);
  if (
    mode === "after-response" &&
    owner === ownerId &&
    issueResponseReturned &&
    !heldAfterResponse &&
    record?.state === "exchange_pending"
  ) {
    heldAfterResponse = true;
    signalReady("after-auth-response-before-verification");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return record;
};

const coordinator = createAuthCoordinator({
  store,
  credentialStore,
  controlGateway: {
    requestGameLaunch: async () => ({
      status: "ready",
      launchData: "signed-fixture-launch",
    }),
  },
  issueGameCredential: async () => {
    recordActivity("issue");
    if (mode === "after-response") {
      issueResponseReturned = true;
      return Response.json({ accessToken });
    }
    return Response.json({ accessToken });
  },
  verifyGameCredential: async () => {
    recordActivity("verify");
    if (mode === "before-cas") verificationResponseReturned = true;
    return Response.json({
      telegramId: ownerId,
      playerId: Number(playerId),
      nickname: "Fixture",
    });
  },
  adoptGameCredential: async () => {
    recordActivity("adopt");
  },
  revokeGameSession: async () => {},
  isDeviceActive: () => true,
  now: () => now,
  uuid: () => operationId,
});

await coordinator.start(
  { ownerId, consentGeneration: 4, routeEpoch: 1 },
  "00000000-0000-4000-8000-000000000456",
);
setInterval(() => {}, 60_000);
