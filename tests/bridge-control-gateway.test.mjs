import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import test from "node:test";
import { createBridgeControlGateway } from "../scripts/bridge/control-gateway.mjs";
import { MAX_DATA_FRAME_BYTES } from "../scripts/bridge/protocol-v1/data-channel.mjs";

const deviceId = "00000000-0000-4000-8000-000000000401";
const connectionId = "00000000-0000-4000-8000-000000000402";
const sessionSigningKey = new Uint8Array(32).fill(77);
const session = Object.freeze({
  ownerId: "54321",
  deviceId,
  deviceGeneration: 2,
  connectionId,
  routeEpoch: 9,
  expiresAtMs: Date.now() + 60_000,
  scopes: ["control", "data"],
});
const otherSession = Object.freeze({
  ...session,
  ownerId: "65432",
  deviceId: "00000000-0000-4000-8000-000000000421",
  connectionId: "00000000-0000-4000-8000-000000000422",
});

async function withGateway(
  run,
  { enabled = true, authorize, gatewayOptions = {} } = {},
) {
  const helperPauses = new Map();
  const gateway = createBridgeControlGateway({
    ...gatewayOptions,
    registry: {
      authorizeDeviceSession:
        authorize ||
        (async (credential) => {
          if (credential !== "signed.session.credential")
            throw new Error("device_session_invalid");
          return session;
        }),
      getHelperPaused(ownerId) {
        return helperPauses.get(ownerId) ?? false;
      },
      setHelperPaused(ownerId, paused) {
        helperPauses.set(ownerId, paused);
        return { paused };
      },
    },
    sessionSigningKey,
    enabled,
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head).catch(() => socket.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  try {
    await run({
      gateway,
      getHelperPaused: () => helperPauses.get(session.ownerId) ?? false,
      url: `ws://127.0.0.1:${address.port}/bridge/control`,
      dataUrl: `ws://127.0.0.1:${address.port}/bridge/data`,
    });
  } finally {
    gateway.close();
    server.close();
    await once(server, "close");
  }
}

function expectHandshakeStatus(url, options, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("unexpected_websocket_open"));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("error", (error) => {
      if (error.message !== "unexpected server response") reject(error);
    });
  }).then((status) => assert.equal(status, expectedStatus));
}

function message(socket) {
  return once(socket, "message").then(([data, isBinary]) => {
    assert.equal(isBinary, false);
    return JSON.parse(data.toString("utf8"));
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition_not_reached");
}

function connectionResult(socket) {
  return new Promise((resolve) => {
    socket.once("open", () => resolve({ kind: "open" }));
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ kind: "rejected", status: response.statusCode });
    });
    socket.once("error", (error) => resolve({ kind: "error", error }));
  });
}

test("control WSS requires a current session credential and a valid protocol hello", async () => {
  await withGateway(async ({ url }) => {
    await expectHandshakeStatus(url, {}, 401);
    await expectHandshakeStatus(
      url,
      {
        headers: {
          authorization: "Bearer signed.session.credential",
          origin: "https://attacker.invalid",
        },
      },
      403,
    );

    const socket = new WebSocket(url, {
      headers: { authorization: "Bearer signed.session.credential" },
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1"],
      }),
    );
    assert.deepEqual(await message(socket), {
      type: "hello_ok",
      protocolMajor: 1,
      protocolMinor: 0,
      connectionId,
      heartbeatSeconds: 20,
      capabilities: ["cargo-byte-tunnel-v1"],
    });
    const nonce = Buffer.alloc(32, 22).toString("base64url");
    socket.send(JSON.stringify({ type: "ping", nonce }));
    assert.deepEqual(await message(socket), { type: "pong", nonce });
    socket.close();
    await once(socket, "close");
  });
});

test("missed control heartbeat closes its active data stream", async () => {
  let monotonic = 0;
  let heartbeatTick;
  await withGateway(
    async ({ gateway, url, dataUrl }) => {
      const options = {
        headers: { authorization: "Bearer signed.session.credential" },
      };
      const control = new WebSocket(url, options);
      await once(control, "open");
      control.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      const hello = await message(control);
      assert.equal(hello.type, "hello_ok");

      const opening = gateway.openStream({
        ownerId: session.ownerId,
        deviceId: session.deviceId,
        routeEpoch: session.routeEpoch,
      });
      const openFrame = await message(control);
      assert.equal(openFrame.type, "open_stream");
      const data = new WebSocket(dataUrl, {
        headers: {
          ...options.headers,
          "x-madhouse-stream-ticket": openFrame.streamTicket,
        },
      });
      await once(data, "open");
      control.send(
        JSON.stringify({
          type: "stream_ready",
          requestId: openFrame.requestId,
          streamId: openFrame.streamId,
        }),
      );
      const tunnel = await opening;
      tunnel.on("error", () => {});
      assert.equal(gateway.activeStreamCount, 1);

      const controlClosed = once(control, "close");
      const dataClosed = once(data, "close");
      heartbeatTick();
      const ping = await message(control);
      assert.equal(ping.type, "ping");

      monotonic = 60_000;
      heartbeatTick();
      const [code, reason] = await controlClosed;
      await dataClosed;
      assert.equal(code, 4001);
      assert.equal(reason.toString(), "heartbeat_timeout");
      assert.equal(gateway.activeStreamCount, 0);
      assert.equal(data.readyState, WebSocket.CLOSED);
    },
    {
      gatewayOptions: {
        monotonicNow: () => monotonic,
        scheduleHeartbeat(callback) {
          heartbeatTick = callback;
          return { unref() {} };
        },
        cancelHeartbeat() {},
      },
    },
  );
});

test("helper pause closes an open tunnel, survives reconnect, and blocks new streams until resume", async () => {
  await withGateway(async ({ gateway, url, dataUrl, getHelperPaused }) => {
    const options = {
      headers: { authorization: "Bearer signed.session.credential" },
    };
    const hello = (socket) =>
      new Promise((resolve, reject) => {
        const messages = [];
        const onMessage = (data, isBinary) => {
          if (isBinary) {
            socket.off("message", onMessage);
            reject(new Error("unexpected_binary_control_frame"));
            return;
          }
          messages.push(JSON.parse(data.toString("utf8")));
          if (messages.length === 2) {
            socket.off("message", onMessage);
            resolve(messages);
          }
        };
        socket.on("message", onMessage);
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolMajor: 1,
            protocolMinor: 0,
            clientVersion: "0.1.0",
            capabilities: ["cargo-byte-tunnel-v1", "helper-pause-v1"],
          }),
        );
      });
    const first = new WebSocket(url, options);
    await once(first, "open");
    const firstHello = await hello(first);
    assert.equal(firstHello[0].type, "hello_ok");
    assert.deepEqual(firstHello[1], {
      type: "helper_state",
      paused: false,
    });

    const opening = gateway.openStream({
      ownerId: session.ownerId,
      deviceId: session.deviceId,
      routeEpoch: session.routeEpoch,
    });
    const openFrame = await message(first);
    assert.equal(openFrame.type, "open_stream");
    const data = new WebSocket(dataUrl, {
      headers: {
        authorization: "Bearer signed.session.credential",
        "x-madhouse-stream-ticket": openFrame.streamTicket,
      },
    });
    await once(data, "open");
    first.send(
      JSON.stringify({
        type: "stream_ready",
        requestId: openFrame.requestId,
        streamId: openFrame.streamId,
      }),
    );
    const tunnel = await opening;
    tunnel.on("error", () => {});
    assert.equal(gateway.activeStreamCount, 1);

    const pauseRequestId = "00000000-0000-4000-8000-000000000431";
    const pauseMessages = new Promise((resolve, reject) => {
      const received = [];
      const onMessage = (raw, isBinary) => {
        if (isBinary) {
          first.off("message", onMessage);
          reject(new Error("unexpected_binary_control_frame"));
          return;
        }
        received.push(JSON.parse(raw.toString("utf8")));
        if (received.at(-1).type === "helper_control_result") {
          first.off("message", onMessage);
          resolve(received);
        }
      };
      first.on("message", onMessage);
    });
    const tunnelClosed = once(tunnel, "close");
    const dataClosed = once(data, "close");
    first.send(
      JSON.stringify({
        type: "helper_control",
        requestId: pauseRequestId,
        action: "pause",
      }),
    );
    const pauseFrames = await pauseMessages;
    assert.deepEqual(pauseFrames, [
      {
        type: "close_stream",
        streamId: openFrame.streamId,
        reason: "paused",
      },
      {
        type: "helper_control_result",
        requestId: pauseRequestId,
        paused: true,
      },
    ]);
    await Promise.all([tunnelClosed, dataClosed]);
    assert.equal(gateway.activeStreamCount, 0);
    assert.equal(getHelperPaused(), true);
    await assert.rejects(
      gateway.openStream({
        ownerId: session.ownerId,
        deviceId: session.deviceId,
        routeEpoch: session.routeEpoch,
      }),
      { code: "helper_paused" },
    );
    const firstClosed = once(first, "close");
    first.close();
    await firstClosed;

    const reconnected = new WebSocket(url, options);
    await once(reconnected, "open");
    const reconnectedHello = await hello(reconnected);
    assert.equal(reconnectedHello[0].type, "hello_ok");
    assert.deepEqual(reconnectedHello[1], {
      type: "helper_state",
      paused: true,
    });
    const resumeRequestId = "00000000-0000-4000-8000-000000000432";
    reconnected.send(
      JSON.stringify({
        type: "helper_control",
        requestId: resumeRequestId,
        action: "resume",
      }),
    );
    assert.deepEqual(await message(reconnected), {
      type: "helper_control_result",
      requestId: resumeRequestId,
      paused: false,
    });
    assert.equal(getHelperPaused(), false);
    const reconnectedClosed = once(reconnected, "close");
    reconnected.close();
    await reconnectedClosed;
  });
});

test("control WSS rejects unsupported versions and missing capabilities before readiness", async () => {
  await withGateway(async ({ gateway, url }) => {
    const baseHello = {
      type: "hello",
      protocolMajor: 1,
      protocolMinor: 0,
      clientVersion: "0.1.0",
      capabilities: ["cargo-byte-tunnel-v1"],
    };
    const attempts = [
      {
        hello: { ...baseHello, protocolMajor: 2 },
        closeReason: "invalid_control_message",
      },
      {
        hello: { ...baseHello, protocolMinor: 1 },
        closeReason: "invalid_control_message",
      },
      {
        hello: { ...baseHello, capabilities: [] },
        closeReason: "capability_required",
      },
    ];

    for (const attempt of attempts) {
      const socket = new WebSocket(url, {
        headers: { authorization: "Bearer signed.session.credential" },
      });
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(JSON.stringify(attempt.hello));
      const [code, reason] = await closed;

      assert.equal(code, 1008);
      assert.equal(reason.toString(), attempt.closeReason);
      assert.equal(gateway.activeConnectionCount, 0);
      await assert.rejects(
        gateway.openStream({
          ownerId: session.ownerId,
          deviceId: session.deviceId,
          routeEpoch: session.routeEpoch,
        }),
        { code: "bridge_offline" },
      );
    }
  });
});

test("control WSS permits only one device connection and closes on revoke", async () => {
  await withGateway(async ({ gateway, url }) => {
    const options = {
      headers: { authorization: "Bearer signed.session.credential" },
    };
    const first = new WebSocket(url, options);
    await once(first, "open");
    await expectHandshakeStatus(url, options, 409);
    gateway.closeDevice(deviceId, 3);
    const [code] = await once(first, "close");
    assert.equal(code, 4003);
    assert.equal(gateway.activeConnectionCount, 0);
  });
});

test("a reconnect burst admits at most one control socket for a device", async () => {
  await withGateway(async ({ gateway, url }) => {
    const options = {
      headers: { authorization: "Bearer signed.session.credential" },
    };
    const attempts = Array.from(
      { length: 12 },
      () => new WebSocket(url, options),
    );
    const results = await Promise.all(attempts.map(connectionResult));
    const openIndexes = results.flatMap((result, index) =>
      result.kind === "open" ? [index] : [],
    );

    assert.equal(openIndexes.length, 1);
    assert.equal(
      results.filter(
        (result) => result.kind === "rejected" && result.status === 409,
      ).length,
      attempts.length - 1,
    );
    assert.equal(gateway.activeConnectionCount, 1);

    const acceptedSocket = attempts[openIndexes[0]];
    const closed = once(acceptedSocket, "close");
    acceptedSocket.close();
    await closed;
    await waitFor(() => gateway.activeConnectionCount === 0);
  });
});

test("control capacity rejects another owner and recovers after disconnect", async () => {
  const credentials = new Map([
    ["first.session.credential", session],
    ["second.session.credential", otherSession],
  ]);
  await withGateway(
    async ({ gateway, url }) => {
      const first = new WebSocket(url, {
        headers: { authorization: "Bearer first.session.credential" },
      });
      await once(first, "open");
      const secondOptions = {
        headers: { authorization: "Bearer second.session.credential" },
      };
      await expectHandshakeStatus(url, secondOptions, 503);
      assert.equal(gateway.activeConnectionCount, 1);
      const closed = once(first, "close");
      first.close();
      await closed;
      await waitFor(() => gateway.activeConnectionCount === 0);
      const second = new WebSocket(url, secondOptions);
      await once(second, "open");
      const secondClosed = once(second, "close");
      second.close();
      await secondClosed;
    },
    {
      authorize: async (credential) => credentials.get(credential),
      gatewayOptions: { maxControlConnections: 1 },
    },
  );
});

test("pending upgrades are bounded before asynchronous authorization and capacity is released", async () => {
  let release;
  let started = false;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await withGateway(
    async ({ url }) => {
      const options = {
        headers: { authorization: "Bearer signed.session.credential" },
      };
      const first = new WebSocket(url, options);
      await waitFor(() => started);
      await expectHandshakeStatus(url, options, 503);
      release();
      await once(first, "open");
      const closed = once(first, "close");
      first.close();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      const next = new WebSocket(url, options);
      await once(next, "open");
      const nextClosed = once(next, "close");
      next.close();
      await nextClosed;
    },
    {
      authorize: async () => {
        started = true;
        await blocked;
        return session;
      },
      gatewayOptions: { maxPendingUpgrades: 1 },
    },
  );
});

test("a disconnected client cannot become a ghost connection after delayed authorization", async () => {
  let release;
  let started = false;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await withGateway(
    async ({ gateway, url }) => {
      const options = {
        headers: { authorization: "Bearer signed.session.credential" },
      };
      const abandoned = new WebSocket(url, options);
      abandoned.on("error", () => {});
      await waitFor(() => started);
      const abandonedClosed = new Promise((resolve) =>
        abandoned.once("close", resolve),
      );
      abandoned.terminate();
      await abandonedClosed;
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gateway.activeConnectionCount, 0);
      const next = new WebSocket(url, options);
      await once(next, "open");
      const nextClosed = once(next, "close");
      next.close();
      await nextClosed;
    },
    {
      authorize: async () => {
        started = true;
        await blocked;
        return session;
      },
      gatewayOptions: { maxPendingUpgrades: 1 },
    },
  );
});

test("upgrade timeout closes the client but keeps hung authorization inside its bounded slot", async () => {
  let release;
  let started = false;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  await withGateway(
    async ({ gateway, url }) => {
      const options = {
        headers: { authorization: "Bearer signed.session.credential" },
      };
      try {
        await expectHandshakeStatus(url, options, 503);
        assert.equal(started, true);
        // A timeout cannot permit an unbounded number of still-running checks.
        await expectHandshakeStatus(url, options, 503);
        assert.equal(gateway.activeConnectionCount, 0);
      } finally {
        release();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(gateway.activeConnectionCount, 0);
      const next = new WebSocket(url, options);
      await once(next, "open");
      const closed = once(next, "close");
      next.close();
      await closed;
    },
    {
      authorize: async () => {
        started = true;
        await blocked;
        return session;
      },
      gatewayOptions: { maxPendingUpgrades: 1, upgradeTimeoutMs: 25 },
    },
  );
});

test("one device disconnect does not prevent another owner from opening a stream", async () => {
  const credentials = new Map([
    ["first.session.credential", session],
    ["second.session.credential", otherSession],
  ]);
  await withGateway(
    async ({ gateway, url, dataUrl }) => {
      const first = new WebSocket(url, {
        headers: { authorization: "Bearer first.session.credential" },
      });
      const second = new WebSocket(url, {
        headers: { authorization: "Bearer second.session.credential" },
      });
      await Promise.all([once(first, "open"), once(second, "open")]);
      for (const control of [first, second])
        control.send(
          JSON.stringify({
            type: "hello",
            protocolMajor: 1,
            protocolMinor: 0,
            clientVersion: "0.1.0",
            capabilities: ["cargo-byte-tunnel-v1"],
          }),
        );
      assert.equal((await message(first)).type, "hello_ok");
      assert.equal(
        (await message(second)).connectionId,
        otherSession.connectionId,
      );
      assert.equal(gateway.activeConnectionCount, 2);

      const firstClosed = once(first, "close");
      first.terminate();
      await firstClosed;
      await waitFor(() => gateway.activeConnectionCount === 1);
      assert.equal(second.readyState, WebSocket.OPEN);

      const opening = gateway.openStream({
        ownerId: otherSession.ownerId,
        deviceId: otherSession.deviceId,
        routeEpoch: otherSession.routeEpoch,
      });
      const openFrame = await message(second);
      assert.equal(openFrame.type, "open_stream");
      const dataSocket = new WebSocket(dataUrl, {
        headers: {
          authorization: "Bearer second.session.credential",
          "x-madhouse-stream-ticket": openFrame.streamTicket,
        },
      });
      await once(dataSocket, "open");
      second.send(
        JSON.stringify({
          type: "stream_ready",
          requestId: openFrame.requestId,
          streamId: openFrame.streamId,
        }),
      );
      const tunnel = await opening;
      assert.equal(tunnel.bridgeConnectionId, otherSession.connectionId);
      assert.equal(gateway.activeConnectionCount, 1);
      assert.equal(gateway.activeStreamCount, 1);

      const secondClosed = once(second, "close");
      const dataClosed = once(dataSocket, "close");
      second.close();
      await Promise.all([secondClosed, dataClosed]);
      await waitFor(() => gateway.activeConnectionCount === 0);
    },
    {
      authorize: async (credential) => {
        const authorized = credentials.get(credential);
        if (!authorized) throw new Error("device_session_invalid");
        return authorized;
      },
    },
  );
});

test("control WSS returns correlated official game launch data to its requester", async () => {
  await withGateway(async ({ gateway, url }) => {
    const control = new WebSocket(url, {
      headers: { authorization: "Bearer signed.session.credential" },
    });
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1", "official-game-launch-v1"],
      }),
    );
    const hello = await message(control);
    assert.deepEqual(hello.capabilities, [
      "cargo-byte-tunnel-v1",
      "official-game-launch-v1",
    ]);

    const operationId = "00000000-0000-4000-8000-000000000405";
    const response = gateway.requestGameLaunch({
      ownerId: session.ownerId,
      deviceId,
      operationId,
      consentGeneration: 7,
      routeEpoch: session.routeEpoch,
    });
    const request = await message(control);
    assert.deepEqual(request, {
      type: "request_game_launch",
      requestId: request.requestId,
      operationId,
      consentGeneration: 7,
      purpose: "official-game-auth",
    });
    control.send(
      JSON.stringify({
        type: "game_launch_result",
        requestId: request.requestId,
        operationId,
        consentGeneration: 7,
        status: "ready",
        launchData: "user=54321&hash=fake-launch-fixture",
      }),
    );
    assert.deepEqual(await response, {
      type: "game_launch_result",
      requestId: request.requestId,
      operationId,
      consentGeneration: 7,
      status: "ready",
      launchData: "user=54321&hash=fake-launch-fixture",
    });
    control.close();
    await once(control, "close");
  });
});

test("cancelled launch results are discarded and release the bounded request slot", async () => {
  await withGateway(async ({ gateway, url }) => {
    const control = new WebSocket(url, {
      headers: { authorization: "Bearer signed.session.credential" },
    });
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1", "official-game-launch-v1"],
      }),
    );
    await message(control);

    const abort = new AbortController();
    const operationId = "00000000-0000-4000-8000-000000000406";
    const cancelled = gateway.requestGameLaunch({
      ownerId: session.ownerId,
      deviceId,
      operationId,
      consentGeneration: 8,
      routeEpoch: session.routeEpoch,
      signal: abort.signal,
    });
    const request = await message(control);
    abort.abort();
    assert.deepEqual(await cancelled, { status: "cancelled" });
    assert.equal(gateway.activeGameLaunchCount, 1);

    control.send(
      JSON.stringify({
        type: "game_launch_result",
        requestId: request.requestId,
        operationId,
        consentGeneration: 8,
        status: "ready",
        launchData: "must-be-discarded",
      }),
    );
    await waitFor(() => gateway.activeGameLaunchCount === 0);
    assert.equal(control.readyState, WebSocket.OPEN);
    control.close();
    await once(control, "close");
  });
});

test("control WSS issues a one-use data channel and exposes only a bounded Duplex", async () => {
  await withGateway(async ({ gateway, url, dataUrl }) => {
    const options = {
      headers: { authorization: "Bearer signed.session.credential" },
    };
    const control = new WebSocket(url, options);
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1"],
      }),
    );
    assert.equal((await message(control)).type, "hello_ok");

    const opening = gateway.openStream({
      ownerId: session.ownerId,
      deviceId,
      routeEpoch: session.routeEpoch,
    });
    const openFrame = await message(control);
    assert.equal(openFrame.type, "open_stream");
    assert.equal(openFrame.target, "cargo-main");
    assert.equal(openFrame.routeEpoch, session.routeEpoch);

    const dataOptions = {
      headers: {
        authorization: "Bearer signed.session.credential",
        "x-madhouse-stream-ticket": openFrame.streamTicket,
      },
    };
    const dataSocket = new WebSocket(dataUrl, dataOptions);
    await once(dataSocket, "open");
    control.send(
      JSON.stringify({
        type: "stream_ready",
        requestId: openFrame.requestId,
        streamId: openFrame.streamId,
      }),
    );
    const tunnel = await opening;
    assert.equal(tunnel.bridgeConnectionId, session.connectionId);
    assert.equal(gateway.activeStreamCount, 1);

    dataSocket.send(Buffer.from("request-bytes"));
    assert.equal((await once(tunnel, "data"))[0].toString(), "request-bytes");
    tunnel.write(Buffer.from("response-bytes"));
    const [responseBytes, isBinary] = await once(dataSocket, "message");
    assert.equal(isBinary, true);
    assert.equal(responseBytes.toString(), "response-bytes");

    await expectHandshakeStatus(dataUrl, dataOptions, 401);

    const dataClosed = once(dataSocket, "close");
    dataSocket.send(Buffer.alloc(MAX_DATA_FRAME_BYTES + 1));
    const [oversizedCloseCode] = await dataClosed;
    assert.equal(oversizedCloseCode, 1009);
    await waitFor(() => gateway.activeStreamCount === 0);

    control.close();
    await once(control, "close");
    await waitFor(() => gateway.activeConnectionCount === 0);
    assert.equal(gateway.activeConnectionCount, 0);
    assert.equal(gateway.activeStreamCount, 0);
    dataSocket.terminate();
  });
});

test("idle control rechecks an expired session before the next HTTP stream and preserves the active result", async () => {
  let sessionCredentialCurrent = true;
  const renewedConnectionId = "00000000-0000-4000-8000-000000000405";
  const renewedSession = Object.freeze({
    ...session,
    connectionId: renewedConnectionId,
    expiresAtMs: Date.now() + 60_000,
  });
  await withGateway(
    async ({ gateway, url, dataUrl }) => {
      const control = new WebSocket(url, {
        headers: { authorization: "Bearer signed.session.credential" },
      });
      await once(control, "open");
      control.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      assert.equal((await message(control)).type, "hello_ok");

      const opening = gateway.openStream({
        ownerId: session.ownerId,
        deviceId,
        routeEpoch: session.routeEpoch,
      });
      const openFrame = await message(control);
      const dataSocket = new WebSocket(dataUrl, {
        headers: {
          authorization: "Bearer signed.session.credential",
          "x-madhouse-stream-ticket": openFrame.streamTicket,
        },
      });
      await once(dataSocket, "open");
      control.send(
        JSON.stringify({
          type: "stream_ready",
          requestId: openFrame.requestId,
          streamId: openFrame.streamId,
        }),
      );
      const tunnel = await opening;

      sessionCredentialCurrent = false;
      dataSocket.send(Buffer.from("request-bytes"));
      assert.equal((await once(tunnel, "data"))[0].toString(), "request-bytes");
      tunnel.write(Buffer.from("response-bytes"));
      const [responseBytes, isBinary] = await once(dataSocket, "message");
      assert.equal(isBinary, true);
      assert.equal(responseBytes.toString(), "response-bytes");

      const dataClosed = once(dataSocket, "close");
      dataSocket.close();
      await dataClosed;
      await waitFor(() => gateway.activeStreamCount === 0);

      const controlClosed = once(control, "close");
      await assert.rejects(
        gateway.openStream({
          ownerId: session.ownerId,
          deviceId,
          routeEpoch: session.routeEpoch,
        }),
        { code: "route_stale" },
      );
      const [code, reason] = await controlClosed;
      assert.equal(code, 4004);
      assert.equal(reason.toString(), "route_changed");
      assert.equal(gateway.activeStreamCount, 0);

      const renewedControl = new WebSocket(url, {
        headers: { authorization: "Bearer renewed.session.credential" },
      });
      await once(renewedControl, "open");
      renewedControl.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      assert.equal(
        (await message(renewedControl)).connectionId,
        renewedConnectionId,
      );
      const renewedOpening = gateway.openStream({
        ownerId: session.ownerId,
        deviceId,
        routeEpoch: session.routeEpoch,
      });
      const renewedFrame = await message(renewedControl);
      assert.equal(renewedFrame.type, "open_stream");
      assert.equal(renewedFrame.routeEpoch, session.routeEpoch);
      renewedControl.send(
        JSON.stringify({
          type: "close_stream",
          streamId: renewedFrame.streamId,
        }),
      );
      await assert.rejects(renewedOpening, { code: "stream_closed" });
      const renewedClosed = once(renewedControl, "close");
      renewedControl.close();
      await renewedClosed;
    },
    {
      authorize: async (credential) => {
        if (credential === "renewed.session.credential") return renewedSession;
        if (
          credential !== "signed.session.credential" ||
          !sessionCredentialCurrent
        )
          throw new Error("device_session_expired");
        return session;
      },
    },
  );
});

test("stream opening rejects another owner or a stale route before issuing a ticket", async () => {
  await withGateway(
    async ({ gateway, url }) => {
      const control = new WebSocket(url, {
        headers: { authorization: "Bearer signed.session.credential" },
      });
      await once(control, "open");
      control.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      await message(control);
      await assert.rejects(
        gateway.openStream({
          ownerId: "99999",
          deviceId,
          routeEpoch: session.routeEpoch,
        }),
        { code: "route_stale" },
      );
      const [code] = await once(control, "close");
      assert.equal(code, 4004);
    },
    {
      authorize: async (credential) => {
        assert.equal(credential, "signed.session.credential");
        return session;
      },
    },
  );
  await withGateway(
    async ({ gateway, url }) => {
      const control = new WebSocket(url, {
        headers: { authorization: "Bearer signed.session.credential" },
      });
      await once(control, "open");
      control.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      await message(control);
      await assert.rejects(
        gateway.openStream({
          ownerId: session.ownerId,
          deviceId,
          routeEpoch: 8,
        }),
        { code: "route_stale" },
      );
      const [code] = await once(control, "close");
      assert.equal(code, 4004);
    },
    {
      authorize: async (credential) => {
        assert.equal(credential, "signed.session.credential");
        return session;
      },
    },
  );
});

test("disabled control WSS gate rejects upgrades before session checks", async () => {
  await withGateway(
    async ({ url }) => {
      await expectHandshakeStatus(
        url,
        { headers: { authorization: "Bearer signed.session.credential" } },
        404,
      );
    },
    {
      enabled: false,
      authorize: async () => {
        assert.fail("disabled_gateway_must_not_validate_credentials");
      },
    },
  );
});

test("control gateway drains current streams before closing device sockets", async () => {
  await withGateway(async ({ gateway, url }) => {
    const control = new WebSocket(url, {
      headers: { authorization: "Bearer signed.session.credential" },
    });
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1"],
      }),
    );
    await message(control);

    const opening = gateway
      .openStream({
        ownerId: session.ownerId,
        deviceId,
        routeEpoch: session.routeEpoch,
      })
      .catch((error) => error);
    const openMessage = await message(control);
    assert.equal(openMessage.type, "open_stream");

    const draining = gateway.drain({ deadlineInMs: 1000 });
    const drainMessage = await message(control);
    assert.equal(drainMessage.type, "drain");
    assert.equal(drainMessage.routeEpoch, session.routeEpoch);
    assert.equal(drainMessage.deadlineInMs, 1000);
    assert.equal(gateway.activeStreamCount, 1);
    await assert.rejects(
      gateway.openStream({
        ownerId: session.ownerId,
        deviceId,
        routeEpoch: session.routeEpoch,
      }),
      { code: "bridge_offline" },
    );

    control.send(
      JSON.stringify({
        type: "close_stream",
        streamId: openMessage.streamId,
        reason: "completed",
      }),
    );
    assert.equal(await draining, true);
    assert.equal(gateway.activeStreamCount, 0);
    assert.equal((await opening).code, "stream_closed");
    const [code] = await once(control, "close");
    assert.equal(code, 1001);
    await expectHandshakeStatus(
      url,
      { headers: { authorization: "Bearer signed.session.credential" } },
      503,
    );
  });
});

test("Wiki VPS source proxies only the bridge path as a WebSocket upgrade", () => {
  const nginx = readFileSync("scripts/deploy/nginx-vps.conf", "utf8");
  const server = readFileSync("scripts/deploy/vps-server.mjs", "utf8");
  const lifecycle = readFileSync("scripts/deploy/server-lifecycle.mjs", "utf8");
  const compose = readFileSync("scripts/deploy/vps-compose.yml", "utf8");
  const runtime = readFileSync("scripts/automation/runtime.mjs", "utf8");
  const location = nginx.match(/location\s+\^~\s+\/bridge\/\s*\{([^}]+)\}/su);
  assert.ok(location);
  assert.match(location[1], /proxy_set_header Upgrade \$http_upgrade;/u);
  assert.match(location[1], /proxy_set_header Connection "upgrade";/u);
  assert.match(location[1], /proxy_buffering off;/u);
  assert.match(server, /server\.on\("upgrade"/u);
  assert.match(server, /installServerLifecycle/u);
  assert.match(server, /httpSockets/u);
  assert.match(server, /upgradedSockets/u);
  assert.match(lifecycle, /SIGTERM/u);
  assert.match(lifecycle, /SIGINT/u);
  assert.match(compose, /stop_grace_period: 50s/u);
  assert.match(
    runtime,
    /enabled: bridgeCompatibility\.routeSelection\.enabled/u,
  );
});

test("device update drain blocks new work and acknowledges only after its launch completes", async () => {
  await withGateway(async ({ gateway, url }) => {
    const control = new WebSocket(url, {
      headers: { authorization: "Bearer signed.session.credential" },
    });
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: [
          "cargo-byte-tunnel-v1",
          "official-game-launch-v1",
          "device-update-drain-v1",
        ],
      }),
    );
    const hello = await message(control);
    assert.ok(hello.capabilities.includes("device-update-drain-v1"));
    const operationId = "00000000-0000-4000-8000-000000000405";
    const launch = gateway.requestGameLaunch({
      ownerId: session.ownerId,
      deviceId,
      operationId,
      consentGeneration: 7,
      routeEpoch: session.routeEpoch,
    });
    const request = await message(control);
    const drainId = "00000000-0000-4000-8000-000000000407";
    const nonce = Buffer.alloc(32, 4).toString("base64url");
    const next = message(control);
    control.send(
      JSON.stringify({ type: "device_update_drain", requestId: drainId }),
    );
    control.send(JSON.stringify({ type: "ping", nonce }));
    assert.deepEqual(await next, { type: "pong", nonce });
    await assert.rejects(
      gateway.openStream({
        ownerId: session.ownerId,
        deviceId,
        routeEpoch: session.routeEpoch,
      }),
      { code: "bridge_offline" },
    );
    assert.deepEqual(
      await gateway.requestGameLaunch({
        ownerId: session.ownerId,
        deviceId,
        operationId,
        consentGeneration: 7,
        routeEpoch: session.routeEpoch,
      }),
      { status: "unavailable" },
    );
    const drained = message(control);
    control.send(
      JSON.stringify({
        type: "game_launch_result",
        requestId: request.requestId,
        operationId,
        consentGeneration: 7,
        status: "unavailable",
      }),
    );
    assert.equal((await launch).status, "unavailable");
    assert.deepEqual(await drained, {
      type: "device_update_drained",
      requestId: drainId,
    });
    control.close();
    await once(control, "close");
  });
});

test("device update drain keeps an existing stream open and waits for its close", async () => {
  await withGateway(async ({ gateway, url, dataUrl }) => {
    const options = {
      headers: { authorization: "Bearer signed.session.credential" },
    };
    const control = new WebSocket(url, options);
    await once(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1", "device-update-drain-v1"],
      }),
    );
    await message(control);
    const opening = gateway.openStream({
      ownerId: session.ownerId,
      deviceId,
      routeEpoch: session.routeEpoch,
    });
    const openFrame = await message(control);
    const data = new WebSocket(dataUrl, {
      headers: {
        ...options.headers,
        "x-madhouse-stream-ticket": openFrame.streamTicket,
      },
    });
    await once(data, "open");
    control.send(
      JSON.stringify({
        type: "stream_ready",
        requestId: openFrame.requestId,
        streamId: openFrame.streamId,
      }),
    );
    const tunnel = await opening;
    const drainId = "00000000-0000-4000-8000-000000000407";
    const nonce = Buffer.alloc(32, 3).toString("base64url");
    const pong = message(control);
    control.send(
      JSON.stringify({ type: "device_update_drain", requestId: drainId }),
    );
    control.send(JSON.stringify({ type: "ping", nonce }));
    assert.deepEqual(await pong, { type: "pong", nonce });
    assert.equal(data.readyState, WebSocket.OPEN);
    const incoming = once(tunnel, "data");
    data.send(Buffer.from("still active"));
    assert.equal((await incoming)[0].toString(), "still active");
    const drained = message(control);
    data.close();
    assert.deepEqual(await drained, {
      type: "device_update_drained",
      requestId: drainId,
    });
    control.close();
    await once(control, "close");
  });
});
