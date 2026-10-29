import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createDeviceTunnelPool } from "../../scripts/bridge/device-tunnel-pool.mjs";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  close() {
    this.terminate();
  }
  pause() {}
  resume() {}
  send(_data, _options, callback) {
    callback();
  }
}
const identity = { owner: "owner-a", device: "device-a", generation: 1 };

test("each authenticated owner may consume one stream only", async () => {
  const pool = createDeviceTunnelPool({
    authorize: async () => true,
    reconnectWaitMs: 20,
  });
  const socket = new FakeSocket();
  await pool.admit(identity, socket);
  await assert.rejects(pool.open("owner-b"), { code: "bridge_offline" });
  const [first, second] = await Promise.allSettled([
    pool.open("owner-a"),
    pool.open("owner-a"),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  first.value.destroy();
  pool.close();
});

test("a waiting request claims only a fresh reauthenticated tunnel", async () => {
  const pool = createDeviceTunnelPool({
    authorize: async () => true,
    reconnectWaitMs: 1000,
  });
  try {
    const first = new FakeSocket();
    await pool.admit(identity, first);
    const stream = await pool.open("owner-a");
    const waiting = pool.open("owner-a");
    stream.destroy();
    const fresh = new FakeSocket();
    await pool.admit(identity, fresh);
    const next = await waiting;
    assert.equal(next.socket, fresh);
    next.destroy();
  } finally {
    pool.close();
  }
});

test("a closing consumed tunnel does not reject its authenticated replacement", async () => {
  const pool = createDeviceTunnelPool({ authorize: async () => true });
  try {
    const old = new FakeSocket();
    await pool.admit(identity, old);
    const first = await pool.open("owner-a");
    old.readyState = 2;
    const fresh = new FakeSocket();
    await pool.admit(identity, fresh);
    assert.equal(old.readyState, 3);
    const next = await pool.open("owner-a");
    assert.equal(next.socket, fresh);
    first.destroy();
    next.destroy();
  } finally {
    pool.close();
  }
});

test("waiting after a consumed stream ends on revocation or shutdown", async () => {
  for (const action of ["revoke", "close"]) {
    const pool = createDeviceTunnelPool({
      authorize: async () => true,
      reconnectWaitMs: 1000,
    });
    await pool.admit(identity, new FakeSocket());
    const stream = await pool.open("owner-a");
    stream.destroy();
    const waiting = pool.open("owner-a");
    if (action === "revoke") pool.revoke("owner-a", "device-a");
    else pool.close();
    await assert.rejects(waiting, { code: "bridge_offline" });
    pool.close();
  }
});

test("an aborted waiting request never claims the next tunnel", async () => {
  const pool = createDeviceTunnelPool({
    authorize: async () => true,
    reconnectWaitMs: 1000,
  });
  try {
    await pool.admit(identity, new FakeSocket());
    const stream = await pool.open("owner-a");
    stream.destroy();
    const controller = new AbortController();
    const waiting = pool.open("owner-a", { signal: controller.signal });
    controller.abort();
    await assert.rejects(waiting, { code: "bridge_offline" });
    const fresh = new FakeSocket();
    await pool.admit(identity, fresh);
    const next = await pool.open("owner-a");
    assert.equal(next.socket, fresh);
    next.destroy();
  } finally {
    pool.close();
  }
});

test("revoke closes a claimed stream and does not affect another owner", async () => {
  const pool = createDeviceTunnelPool({ authorize: async () => true });
  const first = new FakeSocket();
  const second = new FakeSocket();
  await pool.admit(identity, first);
  await pool.admit(
    { owner: "owner-b", device: "device-b", generation: 1 },
    second,
  );
  const stream = await pool.open("owner-a");
  pool.revoke("owner-a", "device-a");
  assert.equal(first.readyState, 3);
  assert.equal(second.readyState, 1);
  await assert.rejects(pool.open("owner-a"), { code: "bridge_offline" });
  stream.destroy();
  pool.close();
});

test("revocation during async admission rejects a stale authorization", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const pool = createDeviceTunnelPool({ authorize: () => pending });
  const socket = new FakeSocket();
  const admission = pool.admit(identity, socket);
  pool.revoke("owner-a", "device-a");
  release(true);
  await assert.rejects(admission, { code: "bridge_unavailable" });
  assert.equal(socket.readyState, 3);
  pool.close();
});

test("closes idle agent that sends bytes before a request", async () => {
  const pool = createDeviceTunnelPool({ authorize: async () => true });
  const socket = new FakeSocket();
  await pool.admit(identity, socket);
  socket.emit("message", Buffer.from("unsolicited"), true);
  assert.equal(socket.readyState, 3);
  await assert.rejects(pool.open("owner-a"), { code: "bridge_offline" });
  pool.close();
});

test("rechecks authorization immediately before claiming a connection", async () => {
  let active = true;
  const pool = createDeviceTunnelPool({ authorize: async () => active });
  const socket = new FakeSocket();
  await pool.admit(identity, socket);
  active = false;
  await assert.rejects(pool.open("owner-a"), { code: "bridge_offline" });
  assert.equal(socket.readyState, 3);
  pool.close();
});

test("revocation observed from another process closes an active stream", async () => {
  let active = true;
  const pool = createDeviceTunnelPool({
    authorize: async () => active,
    reauthorizeMs: 10,
  });
  const socket = new FakeSocket();
  try {
    await pool.admit(identity, socket);
    const stream = await pool.open("owner-a");
    const closed = new Promise((resolve) => socket.once("close", resolve));
    active = false;
    await closed;
    assert.equal(socket.readyState, 3);
    stream.destroy();
  } finally {
    pool.close();
  }
});

test("an idle connection loss waits for a freshly authenticated replacement", async () => {
  const pool = createDeviceTunnelPool({
    authorize: async () => true,
    reconnectWaitMs: 1000,
  });
  try {
    const old = new FakeSocket();
    await pool.admit(identity, old);
    old.terminate();
    const waiting = pool.open("owner-a");
    const fresh = new FakeSocket();
    await pool.admit(identity, fresh);
    const stream = await waiting;
    assert.equal(stream.socket, fresh);
    stream.destroy();
  } finally {
    pool.close();
  }
});

test("a slow reconnect can complete a waiting request without replaying it", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pool = createDeviceTunnelPool({ authorize: async () => true });
  try {
    const old = new FakeSocket();
    await pool.admit(identity, old);
    old.terminate();
    const pending = pool.open("owner-a");
    t.mock.timers.tick(5100);
    const fresh = new FakeSocket();
    await pool.admit(identity, fresh);
    const stream = await pending;
    assert.equal(stream.socket, fresh);
    stream.destroy();
  } finally {
    pool.close();
  }
});
