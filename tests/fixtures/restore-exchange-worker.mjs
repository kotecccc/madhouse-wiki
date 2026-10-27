import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";
import { createBootstrapAuthCoordinator } from "../../scripts/account/bootstrap-auth-coordinator.mjs";
import { createGameCredentialStore } from "../../scripts/account/game-credential-store.mjs";
import { createFileBackedCredentialStorage } from "./file-backed-credential-storage.mjs";

const ownerId = "7654321";
const requestId = "00000000-0000-4000-8000-000000000101";
const launch = new URLSearchParams({
  auth_date: "1790000000",
  hash: "a".repeat(64),
  user: JSON.stringify({ id: Number(ownerId) }),
}).toString();
const store = createAutomationStateStore({
  directory: process.env.RESTORE_TEST_DIRECTORY,
});
const realCredentials =
  process.env.RESTORE_TEST_MODE === "late_cas"
    ? createGameCredentialStore({
        store: createFileBackedCredentialStorage(
          process.env.RESTORE_TEST_PRIVATE,
        ),
        encryptionKey: process.env.RESTORE_TEST_KEY,
      })
    : null;
const credentials = realCredentials
  ? {
      read: (...args) => realCredentials.read(...args),
      compareAndSwap: async (input) => {
        process.send?.({ type: "cas_started" });
        await new Promise((resolve) => process.once("message", resolve));
        return realCredentials.compareAndSwap(input);
      },
    }
  : {
      read: async () => null,
      compareAndSwap: async () => {
        process.send?.({ type: "unexpected_cas" });
      },
    };
const coordinator = createBootstrapAuthCoordinator({
  store,
  credentialStore: credentials,
  now: () => 1_800_000_000_100,
  issueGameCredential: async () => {
    if (!realCredentials) {
      process.send?.({ type: "dispatched" });
      await new Promise((resolve) => process.once("message", resolve));
    }
    return Response.json({
      accessToken: `e30.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.fixture`,
    });
  },
  verifyGameCredential: async () => {
    if (!realCredentials) process.send?.({ type: "unexpected_verify" });
    return Response.json({ telegramId: ownerId, playerId: "101" });
  },
  adoptGameCredential: async () => {
    process.send?.({ type: "unexpected_adopt" });
  },
});
try {
  await coordinator.exchangeRestore(
    { ownerId, cargoLaunchData: launch },
    requestId,
  );
  process.send?.({ type: "unexpected_success" });
} catch (error) {
  process.send?.({ type: "finished", code: error?.code || "unknown" });
} finally {
  store.close();
  process.disconnect?.();
}
