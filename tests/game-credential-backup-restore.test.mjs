import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { createStorageServer } from "../scripts/storage/server.mjs";
import { createBlobSessionStore } from "../connector/blob-session-store.js";
import { createGameCredentialStore } from "../scripts/account/game-credential-store.mjs";
import { createOwnerGameSessionResolver } from "../scripts/account/owner-session.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createBootstrapAuthCoordinator } from "../scripts/account/bootstrap-auth-coordinator.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createRestoreOperationGuard } from "../scripts/automation/runtime.mjs";
import { createBridgeHttp } from "../scripts/bridge/bridge-http.mjs";
import {
  restoreAutomationStateArchive,
  writeAutomationStateArchive,
} from "../scripts/automation/state-backup.mjs";

const ageAvailable =
  spawnSync("age", ["--version"], { stdio: "ignore" }).status === 0 &&
  spawnSync("age-keygen", ["-h"], { stdio: "ignore" }).status === 0;
const backupScript = fileURLToPath(
  new URL("../scripts/storage/backup-encrypted.sh", import.meta.url),
);

test(
  "age backup restores a synthetic encrypted game credential through the storage service",
  { skip: !ageAvailable },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "game-credential-backup-"));
    const storageToken = "synthetic-storage-token-at-least-thirty-two-bytes";
    const previousOrigin = process.env.MADHOUSE_STORAGE_ORIGIN;
    const previousToken = process.env.MADHOUSE_STORAGE_TOKEN;
    const key = randomBytes(32);
    const token = `e30.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.fixture`;
    const record = {
      schemaVersion: 1,
      ownerId: "54321",
      playerId: "101",
      credentialVersion: 1,
      authOperationId: "00000000-0000-4000-8000-000000000001",
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 0,
      expiresAt: 1900000000000,
      revoked: false,
      accessToken: token,
    };
    let server;
    const start = async (directory) => {
      server = createStorageServer({
        root: directory,
        token: storageToken,
        port: 0,
      });
      await once(server, "listening");
      process.env.MADHOUSE_STORAGE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
      process.env.MADHOUSE_STORAGE_TOKEN = storageToken;
    };
    const stop = async () => {
      server.close();
      await once(server, "close");
      server = null;
    };
    try {
      mkdirSync(join(root, "data"));
      mkdirSync(join(root, "backups"));
      mkdirSync(join(root, "restored"));
      for (const name of ["wiki", "wiki-restored", "scratch"])
        mkdirSync(join(root, name), { mode: 0o700 });
      await start(join(root, "data"));
      const credentials = createGameCredentialStore({
        store: createBlobSessionStore(),
        encryptionKey: key,
      });
      const created = await credentials.compareAndSwap({
        ownerId: record.ownerId,
        expectedEtag: null,
        record,
      });
      const wiki = createAutomationStateStore({
        directory: join(root, "wiki"),
      });
      wiki.bindVerifiedGameAccount(record.ownerId, record.playerId, 100);
      wiki.write(record.playerId, {
        credential: `Bearer ${token}`,
        player: { playerId: 101, nickname: "Synthetic" },
        auto: {
          enabled: true,
          phase: "between_battles",
          nextAttackAt: 1800000000000,
        },
        characterUpgrade: { pending: { stat: "strength", before: 1 } },
      });
      wiki.selectRoutePolicy(record.playerId, {
        policy: "direct",
        activeDeviceId: null,
        expectedRouteEpoch: 0,
        updatedAt: 101,
      });
      const botToken = "123456:synthetic-restore-token";
      const now = 1800000000000;
      const proof = new URLSearchParams({
        auth_date: String(now / 1000),
        user: JSON.stringify({ id: Number(record.ownerId) }),
      });
      const check = [...proof.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, value]) => `${name}=${value}`)
        .join("\n");
      const secret = createHmac("sha256", "WebAppData")
        .update(botToken)
        .digest();
      proof.set(
        "hash",
        createHmac("sha256", secret).update(check).digest("hex"),
      );
      const resolver = (store, credentialStore) =>
        createOwnerGameSessionResolver({
          store,
          credentialStore,
          botToken,
          now: () => now,
        });
      assert.equal(
        (await resolver(wiki, credentials)(proof.toString())).playerId,
        record.playerId,
      );
      const chunks = [];
      await writeAutomationStateArchive({
        directory: join(root, "wiki"),
        temporaryDirectory: join(root, "scratch"),
        output: new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
      });
      wiki.close();
      await stop();
      const identity = join(root, "identity");
      const generation = spawnSync("age-keygen", ["-o", identity], {
        encoding: "utf8",
      });
      assert.equal(generation.status, 0);
      const publicKey = spawnSync("age-keygen", ["-y", identity], {
        encoding: "utf8",
      });
      assert.equal(publicKey.status, 0);
      const backup = spawnSync("bash", [backupScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          MADHOUSE_STORAGE_BACKUP_ROOT: root,
          MADHOUSE_STORAGE_BACKUP_RECIPIENT: publicKey.stdout.trim(),
          MADHOUSE_STORAGE_OFFLINE_CONFIRMED: "1",
        },
      });
      assert.equal(backup.status, 0, backup.stderr);
      // Archive is generated by this isolated test, not supplied by an untrusted party.
      const extraction = spawnSync(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          'age --decrypt --identity "$1" "$2" | tar -xzf - -C "$3"',
          "restore-test",
          identity,
          backup.stdout.trim(),
          join(root, "restored"),
        ],
        { encoding: "utf8" },
      );
      assert.equal(extraction.status, 0, extraction.stderr);
      await start(join(root, "restored", "data"));
      const restored = createGameCredentialStore({
        store: createBlobSessionStore(),
        encryptionKey: key,
      });
      const loaded = await restored.read(record.ownerId);
      assert.deepEqual(loaded.record, record);
      assert.equal(loaded.etag, created.etag);
      await restoreAutomationStateArchive({
        input: Readable.from(chunks),
        directory: join(root, "wiki-restored"),
      });
      const restoredWiki = createAutomationStateStore({
        directory: join(root, "wiki-restored"),
      });
      try {
        assert.equal(restoredWiki.isRestoreGuardActive(), true);
        assert.equal(restoredWiki.readGameAccountBinding(record.ownerId), null);
        await assert.rejects(
          resolver(restoredWiki, restored)(proof.toString()),
          {
            code: "game_session_required",
            status: 401,
          },
        );
        const requestId = "00000000-0000-4000-8000-000000000050";
        const operationId = "00000000-0000-4000-8000-000000000051";
        const newToken = `e30.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.fresh`;
        const calls = [];
        const snapshots = createAccountSnapshots({
          store: restoredWiki,
          allowOperation: createRestoreOperationGuard(restoredWiki),
          fetcher: async (url, init = {}) => {
            const path = new URL(url).pathname;
            calls.push({ path, method: init.method || "GET" });
            if (path === "/api/auth/telegram")
              return Response.json({ accessToken: newToken });
            if (path === "/api/me")
              return Response.json({
                telegramId: Number(record.ownerId),
                playerId: Number(record.playerId),
                nickname: "Synthetic",
              });
            throw new Error("unexpected synthetic game call");
          },
        });
        const service = createAutomationService({
          store: restoredWiki,
          getBoss: (id) => ({ numericId: id }),
          fetcher: snapshots.liveFetch,
          now: () => now + 100,
        });
        try {
          const coordinator = createBootstrapAuthCoordinator({
            store: restoredWiki,
            credentialStore: restored,
            now: () => now + 100,
            uuid: () => operationId,
            issueGameCredential: snapshots.issueBootstrapGameCredential,
            verifyGameCredential: snapshots.verifyBootstrapGameCredential,
            adoptGameCredential: async (candidate) => {
              snapshots.registerVerifiedCredential(
                `Bearer ${candidate.accessToken}`,
                candidate.playerId,
              );
              return service.adoptGameCredential({
                ...candidate,
                authOperationId: candidate.bootstrapOperationId,
              });
            },
          });
          const cargoLaunchData = new URLSearchParams({
            auth_date: String(now / 1000),
            hash: "a".repeat(64),
            user: JSON.stringify({ id: Number(record.ownerId) }),
          }).toString();
          const api = createBridgeHttp({
            registry: {
              startPairing() {},
              pairingStatus() {},
              cancelPairing() {},
            },
            botToken,
            bootstrapCoordinator: coordinator,
            issueRestoreOwnerChallenge: (input) =>
              restoredWiki.issueRestoreOwnerChallenge(input),
            confirmRestoreOwner: (input) =>
              restoredWiki.recordRestoreOwnerConsent(input),
            readRestoreOwnerStatus: (ownerId) =>
              restoredWiki.readRestoreOwnerStatus(ownerId),
            confirmRestoreReview: async ({ ownerId, initData, ...review }) => {
              const session = await resolver(restoredWiki, restored)(initData);
              assert.equal(session.ownerId, ownerId);
              const journal = restoredWiki.readGameAuthBootstrap(ownerId);
              return restoredWiki.confirmRestoredReview({
                ownerId,
                playerId: session.playerId,
                operationId: journal.operationId,
                authorization: session.authorization,
                ...review,
              });
            },
            now: () => now + 100,
          });
          const send = (body) =>
            api(
              new Request("https://madhouse-wiki.ru/api/bridge", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: "https://madhouse-wiki.ru",
                },
                body: JSON.stringify(body),
              }),
              { clientIp: "198.51.100.10" },
            );
          const challengeResponse = await send({
            operation: "restore.challenge",
            requestId: "00000000-0000-4000-8000-000000000052",
            initData: proof.toString(),
          });
          assert.equal(challengeResponse.status, 200);
          const { challenge } = await challengeResponse.json();
          const confirmation = await send({
            operation: "restore.confirm",
            requestId,
            routePolicy: "direct",
            challenge,
            initData: proof.toString(),
          });
          assert.equal(confirmation.status, 200);
          const exchange = await send({
            operation: "restore.exchange",
            requestId,
            cargoLaunchData,
            initData: proof.toString(),
          });
          assert.equal(exchange.status, 200);
          assert.equal((await exchange.json()).status, "review_required");
          const status = await send({
            operation: "restore.status",
            requestId: "00000000-0000-4000-8000-000000000053",
            initData: proof.toString(),
          });
          assert.equal(status.status, 200);
          assert.equal((await status.json()).status, "review_required");
          assert.equal(
            (await restored.read(record.ownerId)).record.credentialVersion,
            2,
          );
          assert.equal(
            restoredWiki.read(record.playerId).credential,
            `Bearer ${newToken}`,
          );
          assert.equal(restoredWiki.read(record.playerId).auto.enabled, false);
          assert.equal(restoredWiki.isRestoreRequired(record.playerId), true);
          assert.deepEqual(
            calls.map(({ path }) => path),
            ["/api/auth/telegram", "/api/me", "/api/me"],
          );
          const repeated = await send({
            operation: "restore.exchange",
            requestId,
            cargoLaunchData,
            initData: proof.toString(),
          });
          assert.equal(repeated.status, 200);
          assert.equal((await repeated.json()).status, "review_required");
          assert.equal(
            calls.filter(({ path }) => path === "/api/auth/telegram").length,
            1,
          );
          assert.equal(
            restoredWiki.isRestoreAccountReauthorized(record.playerId),
            true,
          );
          assert.equal(restoredWiki.isRestoreRequired(record.playerId), true);
          assert.equal(
            (await resolver(restoredWiki, restored)(proof.toString())).playerId,
            record.playerId,
          );
          const verified = await snapshots.verifyIdentity(`Bearer ${newToken}`);
          assert.equal(verified.status, 200);
          assert.equal(calls.at(-1).path, "/api/me");
          assert.equal(restoredWiki.isRestoreRequired(record.playerId), true);
          const reviewChallengeResponse = await send({
            operation: "restore.challenge",
            requestId: "00000000-0000-4000-8000-000000000054",
            initData: proof.toString(),
          });
          assert.equal(reviewChallengeResponse.status, 200);
          const reviewChallenge = (await reviewChallengeResponse.json())
            .challenge;
          const reviewRequest = {
            operation: "restore.review",
            requestId: "00000000-0000-4000-8000-000000000055",
            challenge: reviewChallenge,
            initData: proof.toString(),
          };
          const review = await send(reviewRequest);
          assert.equal(review.status, 200);
          assert.equal((await review.json()).status, "reconciliation_required");
          assert.equal(restoredWiki.isRestoreRequired(record.playerId), true);
          assert.ok(
            restoredWiki.read(record.playerId).characterUpgrade.pending,
          );
          assert.equal((await send(reviewRequest)).status, 409);
        } finally {
          service.close();
        }
      } finally {
        restoredWiki.close();
      }
      await assert.rejects(
        () =>
          restored.compareAndSwap({
            ownerId: record.ownerId,
            expectedEtag: '"stale"',
            record: { ...record, credentialVersion: 2 },
          }),
        /game_credential_conflict/u,
      );
    } finally {
      if (server) await stop();
      if (previousOrigin === undefined)
        delete process.env.MADHOUSE_STORAGE_ORIGIN;
      else process.env.MADHOUSE_STORAGE_ORIGIN = previousOrigin;
      if (previousToken === undefined)
        delete process.env.MADHOUSE_STORAGE_TOKEN;
      else process.env.MADHOUSE_STORAGE_TOKEN = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
