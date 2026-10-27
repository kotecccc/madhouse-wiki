import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { WebSocketDuplex } from "../../scripts/bridge/websocket-duplex.mjs";
import {
  MAX_BUFFERED_BYTES,
  MAX_DATA_FRAME_BYTES,
} from "../../scripts/bridge/protocol-v1/data-channel.mjs";

class FakeDataSocket extends EventEmitter {
  constructor({ bufferedAmount = 0 } = {}) {
    super();
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.sent = [];
    this.paused = false;
    this.closeInfo = null;
  }

  send(data, options, callback) {
    this.sent.push({ data: Buffer.from(data), options });
    callback();
  }

  close(code, reason) {
    this.closeInfo = { code, reason };
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.emit("close", code, Buffer.from(reason));
    });
  }

  terminate() {
    this.readyState = 3;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }
}

function write(stream, chunk) {
  return new Promise((resolve) => stream.write(chunk, resolve));
}

test("data Duplex pauses a slow WebSocket consumer at its bounded readable queue", () => {
  const socket = new FakeDataSocket();
  const tunnel = new WebSocketDuplex(socket);

  for (let index = 0; index < 4; index += 1)
    socket.emit("message", Buffer.alloc(MAX_DATA_FRAME_BYTES), true);

  assert.equal(socket.paused, true);
  assert.equal(tunnel.readableLength, MAX_BUFFERED_BYTES);
  tunnel.destroy();
});

test("real WebSocket pauses a slow reader and resumes without losing bytes", async () => {
  const http = createServer();
  const server = new WebSocketServer({
    server: http,
    perMessageDeflate: false,
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const connected = once(server, "connection");
  const sender = new WebSocket(`ws://127.0.0.1:${http.address().port}`, {
    perMessageDeflate: false,
  });
  let tunnel;
  try {
    const [receiver] = await connected;
    await once(sender, "open");
    tunnel = new WebSocketDuplex(receiver);
    const frames = 16;
    const payload = Buffer.alloc(MAX_DATA_FRAME_BYTES, 0x5a);
    for (let i = 0; i < frames; i++) sender.send(payload, { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(tunnel.readableLength, MAX_BUFFERED_BYTES);
    let total = 0;
    const done = new Promise((resolve, reject) => {
      tunnel.on("data", (chunk) => {
        total += chunk.length;
        if (!chunk.every((byte) => byte === 0x5a))
          reject(new Error("corrupt_tunnel_data"));
        if (total === frames * payload.length) resolve();
      });
      tunnel.once("error", reject);
    });
    await done;
    assert.equal(total, frames * MAX_DATA_FRAME_BYTES);
  } finally {
    tunnel?.destroy();
    sender.terminate();
    server.close();
    http.close();
    await once(http, "close");
  }
});

test("data Duplex rejects oversized inbound and outbound frames", async () => {
  const incomingSocket = new FakeDataSocket();
  const incoming = new WebSocketDuplex(incomingSocket);
  const incomingFailure = once(incoming, "error");
  incomingSocket.emit("message", Buffer.alloc(MAX_DATA_FRAME_BYTES + 1), true);
  const [incomingError] = await incomingFailure;
  assert.equal(incomingError.code, "data_frame_too_large");
  assert.equal(incomingSocket.sent.length, 0);
  assert.equal(incomingSocket.closeInfo.code, 1011);

  const outgoingSocket = new FakeDataSocket();
  const outgoing = new WebSocketDuplex(outgoingSocket);
  const outgoingFailure = once(outgoing, "error");
  const writeError = await write(
    outgoing,
    Buffer.alloc(MAX_DATA_FRAME_BYTES + 1),
  );
  const [outgoingError] = await outgoingFailure;
  assert.equal(writeError.code, "message_too_large");
  assert.equal(outgoingError.code, "message_too_large");
  assert.equal(outgoingSocket.sent.length, 0);
  assert.equal(outgoingSocket.closeInfo.code, 1011);
});

test("data Duplex rejects a write that would exceed the slow consumer buffer", async () => {
  const socket = new FakeDataSocket({
    bufferedAmount: MAX_BUFFERED_BYTES - MAX_DATA_FRAME_BYTES + 1,
  });
  const tunnel = new WebSocketDuplex(socket);
  const streamFailure = once(tunnel, "error");
  const writeError = await write(tunnel, Buffer.alloc(MAX_DATA_FRAME_BYTES));
  const [error] = await streamFailure;

  assert.equal(writeError.code, "backpressure_limit");
  assert.equal(error.code, "backpressure_limit");
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closeInfo.code, 1011);
});

test("data Duplex permits a write exactly at the slow consumer buffer limit", async () => {
  const socket = new FakeDataSocket({
    bufferedAmount: MAX_BUFFERED_BYTES - MAX_DATA_FRAME_BYTES,
  });
  const tunnel = new WebSocketDuplex(socket);
  const writeError = await write(tunnel, Buffer.alloc(MAX_DATA_FRAME_BYTES));

  assert.equal(writeError, null);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].data.byteLength, MAX_DATA_FRAME_BYTES);
  assert.equal(socket.sent[0].options.compress, false);
  tunnel.destroy();
});
