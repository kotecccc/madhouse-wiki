import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAuthCoordinator } from "../scripts/account/auth-coordinator.mjs";
import { createGameCredentialStore } from "../scripts/account/game-credential-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createFileBackedCredentialStorage } from "./fixtures/file-backed-credential-storage.mjs";

const ownerId = "7654321";
const playerId = "987654321";
const operationId = "00000000-0000-4000-8000-000000000123";
const deviceId = "00000000-0000-4000-8000-000000000001";
const now = 1_798_000_000_200;
const fixturePath = fileURLToPath(
  new URL("./fixtures/auth-process-crash-worker.mjs", import.meta.url),
);

function token() {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString(
    "base64url",
  );
  return `${header}.${payload}.signature`;
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function crashAt(mode, { mismatchedOwner = false } = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), `madhouse-auth-crash-${mode}-`),
  );
  const markerPath = join(directory, "ready.marker");
  const activityPath = join(directory, "issuer.log");
  const encryptionKey = randomBytes(32).toString("base64url");
  const expectedMarker = {
    "after-response": "after-auth-response-before-verification",
    "before-cas": "verified-profile-before-private-cas",
    "after-cas": "after-private-cas-before-sqlite-transition",
  }[mode];
  const child = spawn(process.execPath, [fixturePath], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "",
      AUTH_CRASH_DIRECTORY: directory,
      AUTH_CRASH_MARKER: markerPath,
      AUTH_CRASH_ACTIVITY: activityPath,
      AUTH_CRASH_ENCRYPTION_KEY: encryptionKey,
      AUTH_CRASH_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes(`READY:${expectedMarker}`)) resolve();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (!stdout.includes(`READY:${expectedMarker}`))
        reject(
          new Error(
            `auth_crash_fixture_exited_early:${code}:${signal}:${stderr.slice(-2000)}`,
          ),
        );
    });
  });
  let timeout;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`auth_crash_fixture_timeout:${mode}`)),
          20_000,
        );
      }),
    ]);
    assert.equal(await readFile(markerPath, "utf8"), expectedMarker);
    const closed = once(child, "close");
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");

    const store = createAutomationStateStore({
      directory: join(directory, "wiki"),
    });
    const credentialStore = createGameCredentialStore({
      store: createFileBackedCredentialStorage(join(directory, "private")),
      encryptionKey,
    });
    const service = createAutomationService({
      store,
      getBoss: (id) => ({ numericId: id, name: "Fixture" }),
      fetcher: async () => {
        throw new Error("unexpected_game_request");
      },
      identifyPlayer: async () => ({
        telegramId: Number(ownerId),
        playerId: Number(playerId),
        nickname: "Fixture",
      }),
      now: () => now,
    });
    const recoveryCalls = { launch: 0, issue: 0, verify: 0 };
    const coordinator = createAuthCoordinator({
      store,
      credentialStore,
      controlGateway: {
        requestGameLaunch: async () => {
          recoveryCalls.launch++;
          throw new Error("recovery_must_not_request_launch_data");
        },
      },
      issueGameCredential: async () => {
        recoveryCalls.issue++;
        throw new Error("recovery_must_not_issue_again");
      },
      verifyGameCredential: async ({ accessToken }) => {
        recoveryCalls.verify++;
        assert.equal(accessToken, token());
        return Response.json({
          telegramId: mismatchedOwner ? "7654322" : ownerId,
          playerId: Number(playerId),
          nickname: "Fixture",
        });
      },
      adoptGameCredential: (candidate) =>
        service.adoptGameCredential(candidate),
      revokeGameSession: async () => {},
      isDeviceActive: ({ ownerId: currentOwner, deviceId: currentDevice }) =>
        currentOwner === ownerId && currentDevice === deviceId,
      now: () => now,
    });

    try {
      const pending = store.readGameAuthRecovery(ownerId);
      const privateCredential = await credentialStore.read(ownerId);
      assert.ok(pending);
      assert.equal(pending.operationId, operationId);
      assert.equal(
        pending.state,
        mode === "after-response" ? "exchange_pending" : "verification_pending",
      );
      assert.equal(Boolean(privateCredential), mode === "after-cas");

      await assert.rejects(service.identify(`Bearer ${token()}`), {
        status: 401,
        message: "game_session_required",
      });

      const recovered = await coordinator.recover();
      const finalRecovery = store.readGameAuthRecovery(ownerId);
      const finalCredential = await credentialStore.read(ownerId);
      const recoveredReady = mode === "after-cas" && !mismatchedOwner;
      assert.deepEqual(recovered, [
        {
          operationId,
          status: recoveredReady ? "ready" : "auth_outcome_unknown",
        },
      ]);
      assert.equal(finalRecovery.state, recovered[0].status);
      assert.equal(recoveryCalls.launch, 0);
      assert.equal(recoveryCalls.issue, 0);

      if (recoveredReady) {
        assert.equal(recoveryCalls.verify, 1);
        assert.equal(finalCredential.record.accessToken, token());
        assert.equal(finalCredential.record.credentialVersion, 1);
        assert.equal(finalRecovery.credentialVersion, 1);
        assert.equal(store.read(playerId).credential, `Bearer ${token()}`);
        assert.equal(
          (await service.identify(`Bearer ${token()}`)).credential,
          `Bearer ${token()}`,
        );
        assert.equal(
          (await readOptional(activityPath)).trim().split("\n").join(","),
          "issue,verify,credential-cas",
        );
      } else {
        assert.equal(recoveryCalls.verify, mode === "after-cas" ? 1 : 0);
        assert.equal(Boolean(finalCredential), mismatchedOwner);
        assert.equal(
          finalRecovery.reason,
          mismatchedOwner ? "game_unavailable" : "unknown_outcome",
        );
        if (mismatchedOwner)
          assert.equal(finalCredential.record.accessToken, token());
        else assert.equal(finalCredential, null);
        await assert.rejects(service.identify(`Bearer ${token()}`), {
          status: 401,
          message: "game_session_required",
        });
        const activity = (await readOptional(activityPath)).trim().split("\n");
        assert.equal(activity.filter((value) => value === "issue").length, 1);
        assert.equal(
          activity.filter((value) => value === "verify").length,
          mode === "before-cas" || mode === "after-cas" ? 1 : 0,
        );
      }
    } finally {
      coordinator.close();
      service.close();
      store.close();
    }
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}

for (const mode of ["after-response", "before-cas", "after-cas"])
  test(
    `SIGKILL at auth ${mode} boundary recovers without duplicate issuance`,
    { skip: process.platform === "win32" },
    async () => crashAt(mode),
  );

test(
  "SIGKILL recovery does not adopt a stored candidate for a different Telegram owner",
  { skip: process.platform === "win32" },
  async () => crashAt("after-cas", { mismatchedOwner: true }),
);
