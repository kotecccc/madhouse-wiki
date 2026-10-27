import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBootstrapAuthCoordinator } from "../scripts/account/bootstrap-auth-coordinator.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createGameCredentialStore } from "../scripts/account/game-credential-store.mjs";
import { createFileBackedCredentialStorage } from "./fixtures/file-backed-credential-storage.mjs";

for (const mode of ["late_response", "late_cas"])
  test(
    `another process cannot adopt a superseded restore after ${mode}`,
    { timeout: 10000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "restore-cross-process-"));
      const store = createAutomationStateStore({ directory });
      const ownerId = "7654321",
        requestId = "00000000-0000-4000-8000-000000000101",
        operationId = "00000000-0000-4000-8000-000000000102",
        now = 1_800_000_000_000;
      const launch = new URLSearchParams({
        auth_date: "1790000000",
        hash: "a".repeat(64),
        user: JSON.stringify({ id: Number(ownerId) }),
      }).toString();
      const encryptionKey = randomBytes(32).toString("base64url");
      const privateDirectory = join(directory, "private");
      const credentials =
        mode === "late_cas"
          ? createGameCredentialStore({
              store: createFileBackedCredentialStorage(privateDirectory),
              encryptionKey,
            })
          : {
              read: async () => null,
              compareAndSwap: async () => {
                throw new Error("unexpected_cas");
              },
            };
      const coordinator = createBootstrapAuthCoordinator({
        store,
        credentialStore: credentials,
        now: () => now + 100,
        uuid: () => operationId,
        issueGameCredential: async () => {
          throw new Error("unexpected_issuance");
        },
        verifyGameCredential: async () => {
          throw new Error("unexpected_verification");
        },
        adoptGameCredential: async () => {
          throw new Error("unexpected_adoption");
        },
      });
      let child;
      try {
        store.activateRestoreGuard({ activatedAt: now });
        const issueChallenge = () =>
          store.issueRestoreOwnerChallenge({
            ownerId,
            issuedAt: now,
            identityIssuedAt: now,
          }).challenge;
        store.recordRestoreOwnerConsent({
          ownerId,
          requestId,
          routePolicy: "direct",
          confirmedAt: now,
          identityIssuedAt: now,
          challenge: issueChallenge(),
        });
        await coordinator.prepareRestore(
          { ownerId, cargoLaunchData: launch },
          requestId,
        );
        child = fork(
          fileURLToPath(
            new URL("./fixtures/restore-exchange-worker.mjs", import.meta.url),
          ),
          [],
          {
            env: {
              ...process.env,
              RESTORE_TEST_DIRECTORY: directory,
              RESTORE_TEST_MODE: mode,
              RESTORE_TEST_PRIVATE: privateDirectory,
              RESTORE_TEST_KEY: encryptionKey,
            },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );
        const exited = once(child, "exit");
        const messages = [];
        child.on("message", (message) => messages.push(message));
        const [first] = await once(child, "message");
        assert.equal(
          first.type,
          mode === "late_cas" ? "cas_started" : "dispatched",
        );
        assert.equal(
          store.readGameAuthBootstrap(ownerId).state,
          mode === "late_cas" ? "verification_pending" : "exchange_pending",
        );
        const challenge = issueChallenge();
        const acknowledge = () =>
          coordinator.acknowledgeUnknownRestore({
            ownerId,
            challenge,
            confirmedAt: now + 100,
            identityIssuedAt: now,
          });
        if (mode === "late_cas") {
          await assert.rejects(acknowledge, /game_auth_busy/u);
          store.armRestoreGuardForMarker({ createdAt: now + 200 });
        } else
          assert.deepEqual(await acknowledge(), {
            status: "reauthorization_required",
          });
        const finished = once(child, "message");
        child.send("release");
        const [last] = await finished;
        assert.deepEqual(last, {
          type: "finished",
          code: "game_auth_operation_stale",
        });
        const [code] = await exited;
        assert.equal(code, 0);
        assert.deepEqual(
          messages.map((message) => message.type),
          [mode === "late_cas" ? "cas_started" : "dispatched", "finished"],
        );
        assert.equal(
          store.readGameAuthBootstrap(ownerId)?.reason ?? null,
          mode === "late_cas" ? null : "unknown_acknowledged",
        );
        assert.equal(store.readGameAccountBinding(ownerId), null);
        assert.equal(store.isRestoreRequired("101"), true);
        if (mode === "late_cas") {
          const late = await credentials.read(ownerId);
          assert.equal(late.record.authOperationId, operationId);
          assert.equal(store.isRestoreGuardActive(), true);
        }
      } finally {
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
