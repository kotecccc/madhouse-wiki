import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import WebSocket from "ws";

const fixture = new URL(
  "./fixtures/automation-crash-actor.mjs",
  import.meta.url,
);
const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);
const battleId = "battle-1";
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = createHttpServer();
  await listen(server);
  const { port } = server.address();
  await close(server);
  return port;
}

function startChild(port, directory, certPath) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(fixture), String(port), directory, certPath],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

async function waitForHealth(port, processRef) {
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (processRef.child.exitCode !== null)
      throw new Error(`actor child exited: ${processRef.output()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok && (await response.json()).tunnelReady) return base;
    } catch {
      /* child is starting */
    }
    await pause(25);
  }
  throw new Error(`actor child did not become ready: ${processRef.output()}`);
}

function startRelay(port, gamePort) {
  let stopped = false;
  const sockets = new Set();
  const retries = new Set();
  const events = [];
  function connect() {
    if (stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge/data`, {
      headers: { Authorization: `MadhouseBridge ${deviceId}.${deviceKey}` },
    });
    sockets.add(ws);
    let gameSocket = null;
    ws.once("open", () => {
      events.push("open");
      if (stopped) return ws.terminate();
      gameSocket = createConnection(gamePort, "127.0.0.1");
      sockets.add(gameSocket);
      ws.on("message", (data, binary) => {
        if (binary && gameSocket && !gameSocket.destroyed)
          gameSocket.write(data);
      });
      gameSocket.on("data", (data) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(data, { binary: true, compress: false });
      });
      gameSocket.once("close", () => ws.close());
      gameSocket.on("error", () => ws.terminate());
    });
    const retry = () => {
      sockets.delete(ws);
      if (gameSocket) {
        sockets.delete(gameSocket);
        gameSocket.destroy();
      }
      if (!stopped) {
        const timer = setTimeout(() => {
          retries.delete(timer);
          connect();
        }, 40);
        retries.add(timer);
      }
    };
    ws.once("close", retry);
    ws.on("error", () => ws.terminate());
  }
  connect();
  return {
    events,
    async stop() {
      stopped = true;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      for (const socket of sockets) {
        if (socket instanceof WebSocket) socket.terminate();
        else socket.destroy();
      }
      sockets.clear();
      await pause(20);
    },
  };
}

function waitForRequest(seen, predicate) {
  return new Promise((resolve) => {
    const index = seen.findIndex(predicate);
    if (index >= 0) resolve(seen.splice(index, 1)[0]);
    else seen.push({ predicate, resolve });
  });
}

test(
  "a killed actor leaves a dispatched POST fenced and local queue cancel sends no replay",
  { timeout: 45000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "automation-actor-crash-"));
    const stateDir = join(directory, "state");
    const port = await unusedPort();
    const seen = [];
    const gameRequests = [];
    let postCount = 0;
    const fakeBattle = () => {
      const now = Date.now();
      return {
        battleId,
        bossId: 7,
        status: "active",
        serverTimeUtc: new Date(now).toISOString(),
        cooldownUntilUtc: new Date(now - 5000).toISOString(),
        expiresAtUtc: new Date(now + 120000).toISOString(),
        retryAfterMilliseconds: 0,
        playerHealth: 100,
        playerMaxHealth: 100,
        bossHealth: 90,
        bossMaxHealth: 100,
        myDamage: 10,
        participantCount: 1,
        participants: [{ playerId: 42, nickname: "Crash fake" }],
        actions: [],
        reward: { drops: [] },
      };
    };
    const game = createHttpsServer({ cert, key }, (req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const request = {
          method: req.method,
          path: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        };
        gameRequests.push(request);
        for (let i = 0; i < seen.length; i++) {
          if (seen[i].predicate(request)) {
            seen.splice(i, 1)[0].resolve(request);
            break;
          }
        }
        if (
          req.method === "POST" &&
          req.url === `/api/bosses/battles/${battleId}/attack`
        ) {
          postCount++;
          // Hold the game response until the parent kills the real actor process.
          return;
        }
        const response =
          req.url === "/api/combat"
            ? { activeBattle: null }
            : req.url === "/api/bosses/invitations"
              ? { items: [] }
              : req.url === "/api/me/bag"
                ? { activityItems: [], consumables: [] }
                : req.url === "/api/bosses/7"
                  ? {
                      id: 7,
                      damageMax: 10,
                      activeBattle: fakeBattle(),
                      state: { canStartFight: false },
                    }
                  : req.url === `/api/bosses/battles/${battleId}`
                    ? fakeBattle()
                    : { error: "unexpected_fake_route" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      });
    });
    await listen(game);
    const relay = startRelay(port, game.address().port);
    let current = startChild(
      port,
      stateDir,
      fileURLToPath(new URL("./fixtures/cargo-cert.pem", import.meta.url)),
    );
    const children = [current];
    t.after(async () => {
      await relay.stop();
      for (const item of children) {
        if (item.child.exitCode === null) item.child.kill("SIGKILL");
      }
      await close(game);
      rmSync(directory, { recursive: true, force: true });
    });

    const base = await waitForHealth(port, current);
    const attackSeen = waitForRequest(
      seen,
      (item) =>
        item.method === "POST" &&
        item.path === `/api/bosses/battles/${battleId}/attack`,
    );
    const response = await fetch(`${base}/enqueue`, { method: "POST" });
    assert.equal(response.status, 200, await response.text());
    const attackRequest = await Promise.race([
      attackSeen,
      pause(8000).then(() => {
        throw new Error(
          `fake game saw no queued attack; requests=${JSON.stringify(gameRequests)} child=${current.output()}`,
        );
      }),
    ]);
    assert.equal(attackRequest.authorization, "Bearer actor-crash-fixture");
    assert.equal(postCount, 1);
    const beforeCrash = await (await fetch(`${base}/state`)).json();
    assert.equal(beforeCrash.activeAttempts.length, 1);
    assert.equal(beforeCrash.activeAttempts[0].phase, "dispatched");
    assert.equal(beforeCrash.activeAttempts[0].operationId, "crash-attack-job");
    assert.equal(
      beforeCrash.activeAttempts[0].checkpointOperationId,
      JSON.parse(attackRequest.body).operationId,
    );
    assert.equal(beforeCrash.snapshot.queuedActions[0].status, "running");

    current.child.kill("SIGKILL");
    await new Promise((resolve) => current.child.once("exit", resolve));
    // The server lease is intentionally not stolen until its 15 s TTL expires.
    await pause(15_100);
    current = startChild(
      port,
      stateDir,
      fileURLToPath(new URL("./fixtures/cargo-cert.pem", import.meta.url)),
    );
    children.push(current);
    const restartedBase = await waitForHealth(port, current);
    let restored;
    for (let attempt = 0; attempt < 80; attempt++) {
      restored = await (await fetch(`${restartedBase}/state`)).json();
      if (restored.snapshot?.queuedActions?.length) break;
      await pause(25);
    }
    assert.equal(restored.activeAttempts.length, 1);
    assert.equal(restored.activeAttempts[0].phase, "dispatched");
    assert.equal(restored.activeAttempts[0].transportStoppedAt, undefined);
    assert.equal(restored.snapshot.queuedActions[0].status, "reconciling");
    await pause(300);
    assert.equal(
      postCount,
      1,
      "startup recovery must not replay a dispatched mutation",
    );
    assert.equal(
      gameRequests.filter((item) => item.method === "POST").length,
      1,
    );

    const cancelResponse = await fetch(`${restartedBase}/cancel`, {
      method: "POST",
    });
    const cancelled = await cancelResponse.json();
    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelled));
    assert.equal(
      postCount,
      1,
      "local queue cancellation must not dispatch a game POST",
    );
    assert.equal(cancelled.snapshot.queuedActions[0].status, "reconciling");
    assert.equal(cancelled.snapshot.queuedActions[0].cancelRequested, true);
    assert.equal(
      gameRequests.filter((item) => item.method === "POST").length,
      1,
    );
  },
);
