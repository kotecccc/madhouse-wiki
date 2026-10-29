import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, createConnection } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("relay may deliver bytes buffered at the game socket after server disconnect", async () => {
  const endpoint = createNetServer();
  await listen(endpoint);
  const http = createHttpServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  http.on("upgrade", (_request, socket, head) => {
    websocketServer.handleUpgrade(_request, socket, head, (client) => {
      websocketServer.emit("connection", client, _request);
    });
  });
  await listen(http);

  let acceptedGameSocket;
  let received = Buffer.alloc(0);
  let expectedPayloadLength = 0;
  let receivedPayloadResolve;
  const accepted = new Promise((resolve) => {
    endpoint.once("connection", (socket) => {
      acceptedGameSocket = socket;
      // Hold the receive side so the relay's send can complete into its local
      // socket buffer without the fake endpoint consuming the application bytes.
      socket.pause();
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= expectedPayloadLength)
          receivedPayloadResolve?.();
      });
      resolve();
    });
  });

  const agent = new WebSocket(`ws://127.0.0.1:${http.address().port}`);
  let relayGameSocket;
  let serverSide;
  const disconnected = new Promise((resolve) => {
    websocketServer.once("connection", (socket) => {
      serverSide = socket;
    });
    agent.once("open", () => {
      relayGameSocket = createConnection(endpoint.address().port, "127.0.0.1");
      relayGameSocket.on("error", () => {});
      agent.on("message", (data, isBinary) => {
        assert.equal(isBinary, true);
        relayGameSocket.write(data, () => sentToLocalSocketResolve());
      });
      agent.once("close", resolve);
    });
  });
  let sentToLocalSocketResolve;
  const sentToLocalSocket = new Promise((resolve) => {
    sentToLocalSocketResolve = resolve;
  });

  try {
    await Promise.all([once(agent, "open"), accepted]);
    const payload = Buffer.from("opaque application bytes held by TCP");
    expectedPayloadLength = payload.length;
    const receivedPayload = new Promise((resolve) => {
      receivedPayloadResolve = resolve;
    });
    serverSide.send(payload, { binary: true, compress: false });
    await sentToLocalSocket;

    // A server-side disconnect only closes this data channel. It cannot retract
    // bytes already accepted by the relay's game socket send buffer.
    serverSide.terminate();
    await disconnected;

    acceptedGameSocket.resume();
    await receivedPayload;
    assert.deepEqual(received, payload);
  } finally {
    relayGameSocket?.destroy();
    acceptedGameSocket?.destroy();
    agent.terminate();
    serverSide?.terminate();
    websocketServer.close();
    await close(http);
    await close(endpoint);
  }
});
