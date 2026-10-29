import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import WebSocket from "ws";
import { createDeviceGateway } from "../../scripts/bridge/device-gateway.mjs";
import { createDeviceTunnelPool } from "../../scripts/bridge/device-tunnel-pool.mjs";
import { sendFriendResponseOverBridge } from "../../scripts/bridge/profile-client.mjs";
import { createGameTlsDuplexConnector } from "../../scripts/bridge/tls-duplex-connector.mjs";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createDirectBoundary } from "../../scripts/game/direct-boundary.mjs";
import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";

const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

for (const mode of ["lost", "rate-limited", "python-stop"])
  test(
    `real gateway and WebSocket relay carry one Cargo TLS POST: ${mode}`,
    { skip: mode === "python-stop" && !process.env.MADHOUSE_TEST_BRIDGE_AGENT },
    async () => {
      let received = 0;
      let receivedRequest;
      const abort = new AbortController();
      const game = createHttpsServer({ cert, key }, (req, res) => {
        received++;
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          receivedRequest = {
            method: req.method,
            path: req.url,
            authorization: req.headers.authorization,
            body: Buffer.concat(chunks).toString(),
          };
          // Simulate the game applying the POST and losing its response in transit.
          if (mode === "python-stop") abort.abort();
          else if (mode === "lost") req.socket.destroy();
          else {
            res.writeHead(429, { "Retry-After": "30" });
            res.end("{}");
          }
        });
      });
      await listen(game);

      const registry = {
        ownerKey: (owner) => owner,
        authenticateDevice(id, token) {
          return id === deviceId && token === deviceKey
            ? { owner: "test-owner", device: deviceId, generation: 1 }
            : null;
        },
        isActive(identity) {
          return (
            identity.owner === "test-owner" && identity.device === deviceId
          );
        },
      };
      const pool = createDeviceTunnelPool({
        authorize: registry.isActive,
        reconnectWaitMs: 50,
      });
      const service = {
        admit: ({ deviceId: id, deviceKey: token }, socket) => {
          const identity = registry.authenticateDevice(id, token);
          if (!identity) return socket.terminate();
          return pool.admit(identity, socket);
        },
      };
      const gateway = createDeviceGateway({
        service,
        registry,
        consume: async () => true,
        heartbeatMs: 60_000,
      });
      const bridge = createHttpServer();
      bridge.on(
        "upgrade",
        (req, socket, head) =>
          void gateway.upgrade(req, socket, head, "127.0.0.1"),
      );
      await listen(bridge);

      const agent =
        mode === "python-stop"
          ? null
          : new WebSocket(
              `ws://127.0.0.1:${bridge.address().port}/bridge/data`,
              {
                headers: {
                  Authorization: `MadhouseBridge ${deviceId}.${deviceKey}`,
                },
              },
            );
      let gameSocket;
      agent?.on("open", () => {
        gameSocket = createConnection(game.address().port, "127.0.0.1");
        agent.on("message", (data, binary) => {
          if (binary && !gameSocket.destroyed) gameSocket.write(data);
        });
        gameSocket.on("data", (data) => {
          if (agent.readyState === WebSocket.OPEN)
            agent.send(data, { binary: true, compress: false });
        });
        gameSocket.on("close", () => agent.close());
        gameSocket.on("error", () => agent.terminate());
      });
      let python;

      const gate = createQueueActionGate();
      const authorization = "Bearer fake-token";
      const request = {
        authorization,
        method: "POST",
        path: "/api/friends/requests/42/accept",
        body: "{}",
      };
      const job = {
        id: "queue-test",
        type: "friend.response",
        status: "running",
        args: { playerId: 42, decision: "accept" },
      };
      const directory = mkdtempSync(join(tmpdir(), "bridge-tunnel-journal-"));
      let store = createAutomationStateStore({ directory });
      let boundary = createDirectBoundary({
        env: { MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1" },
        requireBridgeJournal: true,
      });
      boundary.installBridgeStore(store);
      const accountService = createBridgeAccountService({
        accounts: {
          read: () => ({ authorization, playerId: "42", revision: 1 }),
          getRevision: () => 1,
        },
        devices: {
          listDevice: () => ({ deviceId, generation: 1 }),
          open: (owner, options) => pool.open(owner, options),
        },
        registry,
        queueActionGate: gate,
        coordinate: (attempt) => boundary.bridge(attempt),
        sendAction: (options) => {
          const attemptState = { mayHaveSent: false };
          const connector = createGameTlsDuplexConnector({
            openTunnel: options.openTunnel,
            tlsConnect: (config) => connectTls({ ...config, ca: cert }),
            validateTunnel: options.validateTunnel,
            onReady: () => {
              attemptState.mayHaveSent = true;
            },
            onTunnel: (tunnel) => {
              attemptState.tunnel = tunnel;
            },
          });
          return sendFriendResponseOverBridge({
            ...options,
            connector,
            attemptState,
          });
        },
      });

      try {
        if (mode === "python-stop") {
          python = spawn(
            "python3",
            [
              new URL("./fixtures/python-relay.py", import.meta.url).pathname,
              process.env.MADHOUSE_TEST_BRIDGE_AGENT,
              String(bridge.address().port),
              String(game.address().port),
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          await new Promise((resolve, reject) => {
            let output = "";
            python.stdout.on("data", (data) => {
              output += data.toString();
              if (output.includes("RELAY_READY")) resolve();
            });
            python.once("error", reject);
            python.once("exit", (code) =>
              reject(new Error(`relay exited: ${code}`)),
            );
          });
        } else {
          await new Promise((resolve, reject) => {
            agent.once("open", resolve);
            agent.once("error", reject);
          });
        }
        await gate.run(
          job,
          false,
          authorization,
          async () => {
            const attempt = accountService.send(
              "test-owner",
              request.method,
              request.path,
              { body: request.body, signal: abort.signal },
            );
            if (mode === "lost" || mode === "python-stop")
              await assert.rejects(attempt);
            else assert.equal((await attempt).status, 429);
          },
          () => true,
          () => null,
        );

        assert.deepEqual(receivedRequest, {
          method: "POST",
          path: "/api/friends/requests/42/accept",
          authorization,
          body: "{}",
        });
        assert.equal(received, 1);
        assert.ok(
          boundary
            .diagnostics()
            .recent.some(
              (event) =>
                event.egress === "bridge-device" &&
                event.outcome ===
                  (mode === "rate-limited" ? "cooldown" : "uncertain"),
            ),
        );
        if (mode === "lost" || mode === "python-stop") {
          assert.equal(store.readActiveBridgeAttempts().length, 1);
          if (mode === "python-stop") {
            // The acknowledgement may race the request's error event.
            for (
              let i = 0;
              i < 100 &&
              !store.readActiveBridgeAttempts()[0]?.transportStoppedAt;
              i++
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
            assert.ok(store.readActiveBridgeAttempts()[0]?.transportStoppedAt);
          }
          boundary.close();
          store.close();
          store = createAutomationStateStore({ directory });
          boundary = createDirectBoundary({ requireBridgeJournal: true });
          boundary.installBridgeStore(store);
          assert.equal(boundary.diagnostics().durableBlocks, 1);
          assert.equal(received, 1);
        } else {
          assert.equal(store.readActiveBridgeAttempts().length, 0);
        }
      } finally {
        gameSocket?.destroy();
        agent?.terminate();
        python?.kill();
        gateway.close();
        pool.close();
        boundary.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
        await close(bridge);
        await close(game);
      }
    },
  );
