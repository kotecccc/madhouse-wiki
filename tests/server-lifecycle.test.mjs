import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installServerLifecycle } from "../scripts/deploy/server-lifecycle.mjs";

function fakeServer() {
  return {
    listening: true,
    closeCalls: 0,
    idleCloseCalls: 0,
    allConnectionCloseCalls: 0,
    close(callback) {
      this.closeCalls += 1;
      this.listening = false;
      this.closeCallback = callback;
    },
    closeIdleConnections() {
      this.idleCloseCalls += 1;
    },
    closeAllConnections() {
      this.allConnectionCloseCalls += 1;
    },
  };
}

function fakeSocket() {
  return {
    destroyCalls: 0,
    destroy() {
      this.destroyCalls += 1;
    },
  };
}

test("SIGTERM drains once and closes HTTP and upgraded socket registries", async () => {
  const server = fakeServer();
  const signals = new EventEmitter();
  const httpSocket = fakeSocket();
  const upgradedSocket = fakeSocket();
  const httpSockets = new Set([httpSocket]);
  const upgradedSockets = new Set([upgradedSocket]);
  let resolveDrain;
  let drainCalls = 0;
  let closeCalls = 0;
  const runtime = {
    drain() {
      drainCalls += 1;
      return new Promise((resolve) => {
        resolveDrain = resolve;
      });
    },
    close() {
      closeCalls += 1;
    },
  };
  const lifecycle = installServerLifecycle({
    server,
    runtime,
    httpSockets,
    upgradedSockets,
    signalTarget: signals,
  });

  signals.emit("SIGTERM");
  assert.equal(lifecycle.state, "draining");
  assert.equal(server.closeCalls, 1);
  assert.equal(server.idleCloseCalls, 1);
  assert.equal(drainCalls, 1);
  assert.equal(closeCalls, 0);

  resolveDrain(true);
  server.closeCallback();
  assert.equal(await lifecycle.shutdown(), true);
  assert.equal(lifecycle.state, "closed");
  assert.equal(closeCalls, 1);
  assert.equal(server.allConnectionCloseCalls, 1);
  assert.equal(httpSocket.destroyCalls, 1);
  assert.equal(upgradedSocket.destroyCalls, 1);
  signals.emit("SIGTERM");
  assert.equal(closeCalls, 1);
});

test("a second termination signal forces the bounded close path", async () => {
  const server = fakeServer();
  const signals = new EventEmitter();
  const socket = fakeSocket();
  let closeCalls = 0;
  const lifecycle = installServerLifecycle({
    server,
    runtime: {
      drain: () => new Promise(() => {}),
      close() {
        closeCalls += 1;
      },
    },
    upgradedSockets: new Set([socket]),
    signalTarget: signals,
    deadlineInMs: 1000,
  });

  signals.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGTERM");

  assert.equal(await lifecycle.shutdown(), false);
  assert.equal(lifecycle.state, "closed");
  assert.equal(closeCalls, 1);
  assert.equal(socket.destroyCalls, 1);
});

test("drain deadline force closes HTTP and upgraded sockets", async () => {
  const server = fakeServer();
  const signals = new EventEmitter();
  const httpSocket = fakeSocket();
  const upgradedSocket = fakeSocket();
  let closeCalls = 0;
  const lifecycle = installServerLifecycle({
    server,
    runtime: {
      drain: () => new Promise(() => {}),
      close() {
        closeCalls += 1;
      },
    },
    httpSockets: new Set([httpSocket]),
    upgradedSockets: new Set([upgradedSocket]),
    signalTarget: signals,
    deadlineInMs: 10,
  });

  assert.equal(await lifecycle.shutdown(), false);
  assert.equal(lifecycle.state, "closed");
  assert.equal(closeCalls, 1);
  assert.equal(httpSocket.destroyCalls, 1);
  assert.equal(upgradedSocket.destroyCalls, 1);
});
