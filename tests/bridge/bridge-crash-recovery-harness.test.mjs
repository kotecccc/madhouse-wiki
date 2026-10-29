import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import WebSocket from "ws";

const fixture = new URL("./fixtures/crash-recovery-child.mjs", import.meta.url);
const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);

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
    [fixture.pathname, String(port), directory, certPath],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
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
      throw new Error(`recovery child exited: ${processRef.output()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok && (await response.json()).tunnelReady) return base;
    } catch {
      /* child is starting */
    }
    await pause(25);
  }
  throw new Error(
    `recovery child did not become ready: ${processRef.output()}`,
  );
}

function startRelay(port, gamePort) {
  let stopped = false;
  const events = [];
  const sockets = new Set();
  let retries = new Set();
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
    ws.on("error", (error) => {
      events.push(`ws:${error.message}`);
      ws.terminate();
    });
  }
  connect();
  return {
    events,
    async stop() {
      stopped = true;
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
      for (const socket of sockets) socket.destroy?.() ?? socket.terminate?.();
      sockets.clear();
      await pause(20);
    },
  };
}

function waitForRequest(seen) {
  return new Promise((resolve) => seen.push(resolve));
}

test(
  "crash-recovery harness restores the bridge journal and quarantines a delivered strike",
  { timeout: 20000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-crash-recovery-"));
    const stateDir = join(directory, "state");
    const port = await unusedPort();
    const seen = [];
    let hitCount = 0;
    const game = createHttpsServer({ cert, key }, (req, res) => {
      const body = [];
      req.on("data", (chunk) => body.push(chunk));
      req.on("end", () => {
        hitCount++;
        const request = {
          method: req.method,
          path: req.url,
          authorization: req.headers.authorization,
          body: Buffer.concat(body).toString(),
        };
        for (const resolve of seen.splice(0)) resolve(request);
        // Keep the response open: the parent will crash the coordinator after
        // observing delivery, leaving the persisted attempt in dispatched.
        res.on("close", () => {});
      });
    });
    await listen(game);
    const relay = startRelay(port, game.address().port);
    let current = startChild(
      port,
      stateDir,
      new URL("./fixtures/cargo-cert.pem", import.meta.url).pathname,
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
    const received = waitForRequest(seen);
    const pendingAttempt = fetch(`${base}/attempt`, { method: "POST" }).catch(
      (error) => ({ error }),
    );
    let gameRequestTimer;
    const gameRequest = await Promise.race([
      received,
      new Promise((_, reject) => {
        gameRequestTimer = setTimeout(
          () =>
            reject(
              new Error(
                `fake game saw no request; relay: ${relay.events.join("|")}; child output: ${current.output()}`,
              ),
            ),
          5000,
        );
      }),
    ]);
    clearTimeout(gameRequestTimer);
    assert.deepEqual(gameRequest, {
      method: "POST",
      path: "/api/bosses/battles/battle-1/attack",
      authorization: "Bearer crash-recovery-fixture",
      body: JSON.stringify({ operationId: "attack-operation-1" }),
    });

    current.child.kill("SIGKILL");
    await new Promise((resolve) => current.child.once("exit", resolve));
    await pendingAttempt;

    current = startChild(
      port,
      stateDir,
      new URL("./fixtures/cargo-cert.pem", import.meta.url).pathname,
    );
    children.push(current);
    const restartedBase = await waitForHealth(port, current);
    let recovered;
    for (let attempt = 0; attempt < 30; attempt++) {
      recovered = await (await fetch(`${restartedBase}/state`)).json();
      if (recovered.activeAttempts.length === 1) break;
      await pause(25);
    }
    assert.equal(recovered.activeAttempts.length, 1);
    assert.equal(recovered.activeAttempts[0].phase, "dispatched");
    assert.equal(recovered.activeAttempts[0].operationId, "attack-job-1");
    assert.equal(
      recovered.activeAttempts[0].checkpointOperationId,
      "attack-operation-1",
    );
    assert.equal(recovered.diagnostics.durableBlocks, 1);

    const abort = new AbortController();
    const refused = fetch(`${restartedBase}/attempt`, {
      method: "POST",
      signal: abort.signal,
    }).catch(() => null);
    let blockedState;
    for (let attempt = 0; attempt < 120; attempt++) {
      blockedState = await (await fetch(`${restartedBase}/state`)).json();
      if (blockedState.diagnostics.queued === 1) break;
      await pause(25);
    }
    assert.equal(
      blockedState.diagnostics.queued,
      1,
      "second attempt must reach the coordinator and remain fenced",
    );
    abort.abort();
    await refused;
    assert.equal(hitCount, 1);
  },
);
