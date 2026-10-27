import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { Duplex, Readable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Agent, request } from "undici";
import { once as eventOnce } from "node:events";
import { WebSocket } from "ws";
import { after, test } from "node:test";
import {
  CARGO_HOST,
  createGameTlsDuplexConnector,
} from "../../scripts/bridge/tls-duplex-connector.mjs";
import {
  createGameApiTunnelTransport,
  MAX_GAME_RESPONSE_BODY_BYTES,
} from "../../scripts/bridge/game-api-transport.mjs";
import {
  classifyGameOperation,
  createGameApiClient,
} from "../../scripts/bridge/game-api-client.mjs";
import { createBridgeControlGateway } from "../../scripts/bridge/control-gateway.mjs";
import { createFakeCargo, deferred } from "./fake-cargo.mjs";

const cargoCertificate = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const cargoKey = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const wrongHostCertificate = await readFile(
  new URL("./fixtures/wrong-host-cert.pem", import.meta.url),
);
const wrongHostKey = await readFile(
  new URL("./fixtures/wrong-host-key.pem", import.meta.url),
);
const servers = new Set();
const agents = new Set();

function operationIdFor(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

after(async () => {
  await Promise.all([...agents].map((agent) => agent.destroy()));
  await Promise.all([...servers].map((server) => server.close()));
});

class SocketDuplex extends Duplex {
  constructor(socket) {
    super();
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.once("end", () => this.push(null));
    socket.once("error", (error) => this.destroy(error));
    socket.once("close", () => {
      if (!this.destroyed && !this.readableEnded) this.push(null);
    });
  }

  _read() {
    this.socket.resume();
  }

  _write(chunk, encoding, callback) {
    this.socket.write(chunk, encoding, callback);
  }

  _final(callback) {
    this.socket.end(callback);
  }

  _destroy(error, callback) {
    this.socket.destroy();
    callback(error);
  }
}

async function startCargo({
  certificate = cargoCertificate,
  key = cargoKey,
  onRequest,
}) {
  const server = createFakeCargo({
    certificate,
    privateKey: key,
    onRequest,
  });
  servers.add(server);
  const port = await server.listen();
  return { server, port };
}

function createAgent({ port, certificateAuthority } = {}) {
  const agent = new Agent({
    connections: 1,
    pipelining: 0,
    connect: createGameTlsDuplexConnector({
      openTunnel() {
        return new SocketDuplex(createConnection({ host: "127.0.0.1", port }));
      },
      tlsConnect(options) {
        return connectTls({
          ...options,
          ...(certificateAuthority ? { ca: certificateAuthority } : {}),
        });
      },
    }),
  });
  agents.add(agent);
  return agent;
}

async function send(agent, { method = "GET", signal, body } = {}) {
  return request(`https://${CARGO_HOST}/api/me`, {
    dispatcher: agent,
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
    signal,
  });
}

async function closeAgent(agent) {
  agents.delete(agent);
  await agent.destroy();
}

async function closeCargo(server) {
  servers.delete(server);
  await server.close();
}

test("verified TLS carries HTTP over an arbitrary Duplex tunnel", async () => {
  const { server, port } = await startCargo({
    onRequest: async (requestRecord, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: requestRecord.method,
          path: requestRecord.path,
          servername: requestRecord.servername,
        }),
      );
    },
  });
  const agent = createAgent({ port, certificateAuthority: cargoCertificate });
  try {
    const response = await send(agent);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(await response.body.json(), {
      method: "GET",
      path: "/api/me",
      servername: CARGO_HOST,
    });
    assert.equal(server.requests.length, 1);
  } finally {
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("bridge transport rejects a declared response larger than four MiB before exposing it", async () => {
  const body = Readable.from([Buffer.from("unused")]);
  let agentDestroyed = false;
  class FakeAgent {
    compose() {
      return this;
    }

    destroy() {
      agentDestroyed = true;
      return Promise.resolve();
    }
  }
  const bridgeTransport = createGameApiTunnelTransport({
    openStream: async () => {
      throw new Error("the injected HTTP response does not open a stream");
    },
    AgentClass: FakeAgent,
    requestFn: async () => ({
      statusCode: 200,
      headers: {
        "content-length": String(MAX_GAME_RESPONSE_BODY_BYTES + 1),
      },
      body,
    }),
  });

  await assert.rejects(
    bridgeTransport({
      route: {
        policy: "bridge_required",
        routeEpoch: 1,
        activeDeviceId: "00000000-0000-4000-8000-000000000401",
      },
      upstreamPath: "/api/me",
      method: "GET",
      headers: new Headers(),
    }),
    { code: "bridge_response_too_large" },
  );
  assert.equal(body.destroyed, true);
  assert.equal(agentDestroyed, true);
});

test("bridge transport caps an unknown-length response while streaming", async () => {
  const body = Readable.from([
    Buffer.alloc(MAX_GAME_RESPONSE_BODY_BYTES + 1, 0x61),
  ]);
  let agentDestroyed = false;
  class FakeAgent {
    compose() {
      return this;
    }

    destroy() {
      agentDestroyed = true;
      return Promise.resolve();
    }
  }
  const bridgeTransport = createGameApiTunnelTransport({
    openStream: async () => {
      throw new Error("the injected HTTP response does not open a stream");
    },
    AgentClass: FakeAgent,
    requestFn: async () => ({
      statusCode: 200,
      headers: { "content-type": "application/octet-stream" },
      body,
    }),
  });
  const response = await bridgeTransport({
    route: {
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    },
    upstreamPath: "/api/me",
    method: "GET",
    headers: new Headers(),
  });

  await assert.rejects(response.arrayBuffer(), {
    code: "bridge_response_too_large",
  });
  assert.equal(body.destroyed, true);
  assert.equal(agentDestroyed, true);
});

test("bridge transport caps a gzip response after decompression", async () => {
  const compressedBody = gzipSync(
    Buffer.alloc(MAX_GAME_RESPONSE_BODY_BYTES + 1, 0x61),
  );
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "application/octet-stream",
        "content-length": String(compressedBody.byteLength),
      });
      response.end(compressedBody);
    },
  });
  const bridgeTransport = createGameApiTunnelTransport({
    openStream: async () =>
      new SocketDuplex(createConnection({ host: "127.0.0.1", port })),
    tlsConnect(options) {
      return connectTls({ ...options, ca: cargoCertificate });
    },
  });
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("bridge response overflow must not fall back to direct");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 1,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    bridgeTransport,
  });

  try {
    const response = await client.request({
      operation: {
        method: "GET",
        path: "/api/me",
        operationClass: "read",
      },
      path: "/api/me",
      method: "GET",
      headers: { Authorization: "Bearer fixture.token.signature" },
    });
    await assert.rejects(
      response.arrayBuffer(),
      /Decompressed response size .* exceeded maxSize/u,
    );
    assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0].method, "GET");
    assert.equal(directCalls, 0);
  } finally {
    await closeCargo(server);
  }
});

test("an oversized gzip reply after an applied bridge mutation stays incomplete", async () => {
  const compressedBody = gzipSync(
    Buffer.alloc(MAX_GAME_RESPONSE_BODY_BYTES + 1, 0x61),
  );
  let effects = 0;
  const { server, port } = await startCargo({
    onRequest: async (requestRecord, response) => {
      effects += 1;
      assert.equal(requestRecord.method, "POST");
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-type": "application/json",
        "content-length": String(compressedBody.byteLength),
      });
      response.end(compressedBody);
    },
  });
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error(
        "oversized mutation response must not use direct transport",
      );
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 1,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitMutation: async () => ({
      action: "boss.attack",
      commandId: "oversized-gzip-command",
      attemptId: "oversized-gzip-attempt",
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () => {
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000402";
        return tunnel;
      },
      bindMutationConnection: async () => true,
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });

  try {
    const response = await client.request({
      operation: {
        method: "POST",
        path: "/api/bosses/battles/{battleId}/attack",
        operationClass: "mutation",
      },
      path: "/api/bosses/battles/battle-1/attack",
      method: "POST",
      headers: {
        Authorization: "Bearer fixture.token.signature",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId: operationIdFor(401) }),
      context: { accountId: "123456" },
    });
    await assert.rejects(
      response.arrayBuffer(),
      /Decompressed response size .* exceeded maxSize/u,
    );
    assert.equal(server.requests.length, 1);
    assert.equal(effects, 1);
    assert.equal(directCalls, 0);
  } finally {
    await closeCargo(server);
  }
});

test("Cargo redirect responses are surfaced without a second bridged request", async () => {
  const statuses = [301, 302, 303, 307, 308];
  const requests = [];
  const { server, port } = await startCargo({
    onRequest: async (requestRecord, response) => {
      requests.push({ method: requestRecord.method, path: requestRecord.path });
      response.writeHead(statuses[requests.length - 1], {
        Location: "/api/redirect-target",
        "Content-Length": "0",
      });
      response.end();
    },
  });
  const deviceId = "00000000-0000-4000-8000-000000000401";
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("bridge_redirect_must_not_fall_back");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 4,
      activeDeviceId: deviceId,
    }),
    admitMutation: async () => ({
      action: "boss.attack",
      commandId: "redirect-command",
      attemptId: "redirect-attempt",
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () => {
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000402";
        return tunnel;
      },
      bindMutationConnection: async () => true,
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });

  try {
    for (const status of statuses) {
      const response = await client.request({
        operation: {
          method: "POST",
          path: "/api/bosses/battles/{battleId}/attack",
          operationClass: "mutation",
        },
        path: "/api/bosses/battles/battle-1/attack",
        method: "POST",
        headers: {
          Authorization: "Bearer verified.credential",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operationId: operationIdFor(status) }),
        context: { accountId: "123456" },
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("location"), "/api/redirect-target");
      assert.equal(await response.text(), "");
      assert.equal(requests.length, statuses.indexOf(status) + 1);
    }

    assert.deepEqual(
      requests,
      statuses.map(() => ({
        method: "POST",
        path: "/api/bosses/battles/battle-1/attack",
      })),
    );
    assert.equal(server.requests.length, statuses.length);
    assert.equal(directCalls, 0);
  } finally {
    await closeCargo(server);
  }
});

test("GameApiClient binds an admitted mutation to the active stream before TLS dispatch", async () => {
  const connectionId = "00000000-0000-4000-8000-000000000777";
  const events = [];
  const { server, port } = await startCargo({
    onRequest: async (requestRecord, response) => {
      events.push("cargo-request");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: requestRecord.method,
          path: requestRecord.path,
        }),
      );
    },
  });
  let directCalls = 0;
  let openedStreams = 0;
  let admissionChecks = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 4,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitMutation: async ({ request }) => {
      assert.equal(request.context.accountId, "123456");
      return {
        action: "boss.attack",
        commandId: "command-attack-001",
        attemptId: "attempt-attack-001",
      };
    },
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async ({ route }) => {
        openedStreams += 1;
        assert.equal(route.routeEpoch, 4);
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = connectionId;
        return tunnel;
      },
      bindMutationConnection: async ({ admission, connectionId: boundId }) => {
        admissionChecks += 1;
        events.push(`connection-check-${admissionChecks}`);
        assert.deepEqual(admission, {
          action: "boss.attack",
          commandId: "command-attack-001",
          attemptId: "attempt-attack-001",
        });
        assert.equal(boundId, connectionId);
        return true;
      },
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });
  try {
    const response = await client.request({
      operation: {
        method: "POST",
        path: "/api/bosses/battles/battle-1/attack",
        operationClass: "mutation",
      },
      path: "/api/bosses/battles/battle-1/attack",
      method: "POST",
      headers: {
        Authorization: "Bearer verified.credential",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000777",
      }),
      context: { accountId: "123456" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      method: "POST",
      path: "/api/bosses/battles/battle-1/attack",
    });
    assert.deepEqual(events, [
      "connection-check-1",
      "connection-check-2",
      "cargo-request",
      "connection-check-3",
    ]);
    assert.equal(openedStreams, 1);
    assert.equal(directCalls, 0);
    assert.equal(server.requests.length, 1);
    assert.equal(
      server.requests[0].body.toString(),
      JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000777" }),
    );
  } finally {
    await closeCargo(server);
  }
});

test("auth issuance admissions are not treated as boss mutation bindings", async () => {
  const { server, port } = await startCargo({
    onRequest: async (requestRecord, response) => {
      assert.equal(requestRecord.method, "POST");
      assert.equal(requestRecord.path, "/api/auth/telegram");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true }));
    },
  });
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("auth issuance must stay on the bridge route");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 4,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitAuthIssuance: async () => ({
      operationId: "00000000-0000-4000-8000-000000000402",
      routeEpoch: 4,
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () =>
        new SocketDuplex(createConnection({ host: "127.0.0.1", port })),
      bindMutationConnection: async () => {
        assert.fail("auth issuance is not a boss mutation admission");
      },
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });
  try {
    const response = await client.request({
      operation: {
        method: "POST",
        path: "/api/auth/telegram",
        operationClass: "auth_issuance",
      },
      path: "/api/auth/telegram",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData: "signed-launch-data" }),
      context: {
        accountId: "123456",
        ownerId: "7654321",
        playerId: "123456",
        authOperationId: "00000000-0000-4000-8000-000000000403",
        consentGeneration: 2,
        expectedRouteEpoch: 4,
        expectedDeviceId: "00000000-0000-4000-8000-000000000401",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(directCalls, 0);
    assert.equal(server.requests.length, 1);
  } finally {
    await closeCargo(server);
  }
});

test("a credential change after stream binding prevents HTTP dispatch", async () => {
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      response.end("unexpected");
    },
  });
  let authGeneration = 1;
  let admissionChecks = 0;
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("mutation must not fall back to direct transport");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 4,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitMutation: async () => ({
      action: "boss.attack",
      commandId: "command-attack-post-bind",
      attemptId: "attempt-attack-post-bind",
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () => {
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000779";
        return tunnel;
      },
      bindMutationConnection: async () => {
        admissionChecks += 1;
        if (admissionChecks === 1) {
          authGeneration = 2;
          return true;
        }
        return authGeneration === 1;
      },
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });
  try {
    await assert.rejects(
      client.request({
        operation: {
          method: "POST",
          path: "/api/bosses/battles/battle-1/attack",
          operationClass: "mutation",
        },
        path: "/api/bosses/battles/battle-1/attack",
        method: "POST",
        headers: {
          Authorization: "Bearer verified.credential",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operationId: operationIdFor(402) }),
        context: { accountId: "123456" },
      }),
    );
    assert.equal(authGeneration, 2);
    assert.equal(admissionChecks, 2);
    assert.equal(directCalls, 0);
    assert.equal(server.requests.length, 0);
  } finally {
    await closeCargo(server);
  }
});

test("an applied mutation response is discarded when its auth generation changes in flight", async () => {
  const requestStarted = deferred();
  const releaseResponse = deferred();
  let effects = 0;
  let authGeneration = 1;
  let admissionChecks = 0;
  let directCalls = 0;
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      effects += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"applied":true');
      requestStarted.resolve();
      await releaseResponse.promise;
      response.end("}");
    },
  });
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("mutation must not fall back to direct transport");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 4,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitMutation: async () => ({
      action: "boss.attack",
      commandId: "command-attack-inflight",
      attemptId: "attempt-attack-inflight",
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () => {
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000778";
        return tunnel;
      },
      bindMutationConnection: async () => {
        admissionChecks += 1;
        return authGeneration === 1;
      },
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });
  try {
    const responsePromise = client.request({
      operation: {
        method: "POST",
        path: "/api/bosses/battles/battle-1/attack",
        operationClass: "mutation",
      },
      path: "/api/bosses/battles/battle-1/attack",
      method: "POST",
      headers: {
        Authorization: "Bearer verified.credential",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ operationId: operationIdFor(403) }),
      context: { accountId: "123456" },
    });
    await requestStarted.promise;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal(effects, 1);

    authGeneration = 2;
    releaseResponse.resolve();
    await assert.rejects(response.json());
    assert.equal(effects, 1);
    assert.equal(admissionChecks, 3);
    assert.equal(directCalls, 0);
    assert.equal(server.requests.length, 1);
  } finally {
    releaseResponse.resolve();
    await closeCargo(server);
  }
});

test("GameApiClient completes a read through Wiki WSS, desktop TCP relay, and verified fake Cargo TLS", async () => {
  const session = Object.freeze({
    ownerId: "54321",
    deviceId: "00000000-0000-4000-8000-000000000401",
    deviceGeneration: 2,
    connectionId: "00000000-0000-4000-8000-000000000402",
    routeEpoch: 9,
    expiresAtMs: Date.now() + 60_000,
    scopes: ["control", "data"],
  });
  const cargo = await startCargo({
    onRequest: async (record, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: record.path, verified: true }));
    },
  });
  const gateway = createBridgeControlGateway({
    registry: {
      async authorizeDeviceSession(value) {
        if (value !== "signed.session.credential")
          throw new Error("session_invalid");
        return session;
      },
      getHelperPaused() {
        return false;
      },
      setHelperPaused(_ownerId, paused) {
        return { paused };
      },
    },
    sessionSigningKey: new Uint8Array(32).fill(77),
    enabled: true,
  });
  const gatewayServer = createHttpServer();
  gatewayServer.on("upgrade", (requestRecord, socket, head) => {
    gateway
      .handleUpgrade(requestRecord, socket, head)
      .catch(() => socket.destroy());
  });
  gatewayServer.listen(0, "127.0.0.1");
  await eventOnce(gatewayServer, "listening");
  const gatewayPort = gatewayServer.address().port;
  const controlUrl = `ws://127.0.0.1:${gatewayPort}/bridge/control`;
  const dataUrl = `ws://127.0.0.1:${gatewayPort}/bridge/data`;
  const control = new WebSocket(controlUrl, {
    headers: { authorization: "Bearer signed.session.credential" },
  });
  let dataSocket;
  let desktopTcp;
  let sawFixedTarget = false;
  const readyMessage = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("desktop_stream_timeout")),
      10_000,
    );
    timer.unref?.();
    control.on("message", (data, isBinary) => {
      if (isBinary) {
        reject(new Error("unexpected_binary_control_frame"));
        return;
      }
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "open_stream") {
        assert.equal(message.target, "cargo-main");
        assert.equal(message.routeEpoch, session.routeEpoch);
        dataSocket = new WebSocket(dataUrl, {
          headers: {
            authorization: "Bearer signed.session.credential",
            "x-madhouse-stream-ticket": message.streamTicket,
          },
          perMessageDeflate: false,
        });
        dataSocket.once("open", () => {
          desktopTcp = createConnection({
            host: "127.0.0.1",
            port: cargo.port,
          });
          desktopTcp.setNoDelay(true);
          desktopTcp.on("data", (chunk) => {
            if (dataSocket.readyState === WebSocket.OPEN)
              dataSocket.send(chunk, { binary: true, compress: false });
          });
          desktopTcp.once("connect", () => {
            sawFixedTarget = true;
            control.send(
              JSON.stringify({
                type: "stream_ready",
                requestId: message.requestId,
                streamId: message.streamId,
              }),
            );
            resolve();
          });
          desktopTcp.once("error", reject);
          dataSocket.on("message", (bytes, binary) => {
            if (!binary) {
              reject(new Error("desktop_received_text_data"));
              return;
            }
            if (desktopTcp && !desktopTcp.destroyed) desktopTcp.write(bytes);
          });
          dataSocket.once("error", reject);
        });
      } else if (message.type === "close_stream") {
        desktopTcp?.destroy();
        dataSocket?.close();
      }
    });
    control.once("error", reject);
  });
  try {
    await eventOnce(control, "open");
    control.send(
      JSON.stringify({
        type: "hello",
        protocolMajor: 1,
        protocolMinor: 0,
        clientVersion: "0.1.0",
        capabilities: ["cargo-byte-tunnel-v1"],
      }),
    );
    await eventOnce(control, "message");
    const client = createGameApiClient({
      directTransport: async () => {
        assert.fail("bridge_read_must_not_use_direct_transport");
      },
      resolveRoute: async () => ({
        policy: "bridge_required",
        playerId: "123456",
        routeEpoch: session.routeEpoch,
        activeDeviceId: session.deviceId,
      }),
      bridgeTransport: createGameApiTunnelTransport({
        openStream: ({ route, signal }) =>
          gateway.openStream({
            ownerId: session.ownerId,
            deviceId: route.activeDeviceId,
            routeEpoch: route.routeEpoch,
            signal,
          }),
        tlsConnect(options) {
          return connectTls({ ...options, ca: cargoCertificate });
        },
      }),
    });
    const responsePromise = client.request({
      operation: {
        method: "GET",
        path: "/api/me",
        operationClass: classifyGameOperation({
          method: "GET",
          path: "/api/me",
        }),
      },
      path: "/api/me",
    });
    await readyMessage;
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      path: "/api/me",
      verified: true,
    });
    assert.equal(sawFixedTarget, true);
    assert.equal(cargo.server.requests.length, 1);
    for (
      let attempt = 0;
      gateway.activeStreamCount > 0 && attempt < 50;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(gateway.activeStreamCount, 0);
  } finally {
    gateway.close();
    control.terminate();
    dataSocket?.terminate();
    desktopTcp?.destroy();
    await new Promise((resolve) => gatewayServer.close(resolve));
    await closeCargo(cargo.server);
  }
});

test("an untrusted certificate is rejected before HTTP reaches Cargo", async () => {
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => response.end("unexpected"),
  });
  const agent = createAgent({ port });
  try {
    await assert.rejects(send(agent));
    assert.equal(server.requests.length, 0);
  } finally {
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("a trusted certificate for another hostname is rejected", async () => {
  const { server, port } = await startCargo({
    certificate: wrongHostCertificate,
    key: wrongHostKey,
    onRequest: async (_requestRecord, response) => response.end("unexpected"),
  });
  const agent = createAgent({
    port,
    certificateAuthority: wrongHostCertificate,
  });
  try {
    await assert.rejects(send(agent));
    assert.equal(server.requests.length, 0);
  } finally {
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("a disconnected request before application remains an uncertain sent attempt", async () => {
  const received = deferred();
  const releaseBeforeApply = deferred();
  const clientGone = deferred();
  let effects = 0;
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      response.once("close", clientGone.resolve);
      received.resolve();
      await releaseBeforeApply.promise;
      if (response.destroyed) return;
      effects += 1;
      response.end("applied");
    },
  });
  const agent = createAgent({ port, certificateAuthority: cargoCertificate });
  const controller = new AbortController();
  try {
    const pending = send(agent, {
      method: "POST",
      body: JSON.stringify({ action: "fixture" }),
      signal: controller.signal,
    });
    await received.promise;
    controller.abort();
    await assert.rejects(pending);
    await clientGone.promise;
    releaseBeforeApply.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.requests.length, 1);
    assert.equal(effects, 0);
  } finally {
    releaseBeforeApply.resolve();
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("a lost response after application is uncertain and does not replay", async () => {
  const applied = deferred();
  const releaseResponse = deferred();
  let effects = 0;
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      effects += 1;
      applied.resolve();
      await releaseResponse.promise;
      if (!response.destroyed) response.end("applied");
    },
  });
  const agent = createAgent({ port, certificateAuthority: cargoCertificate });
  const controller = new AbortController();
  try {
    const pending = send(agent, {
      method: "POST",
      body: JSON.stringify({ action: "fixture" }),
      signal: controller.signal,
    });
    await applied.promise;
    controller.abort();
    await assert.rejects(pending);
    releaseResponse.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.requests.length, 1);
    assert.equal(effects, 1);
  } finally {
    releaseResponse.resolve();
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("opening no device tunnel fails before any Cargo request", async () => {
  const { server } = await startCargo({
    onRequest: async (_requestRecord, response) => response.end("unexpected"),
  });
  const agent = new Agent({
    connections: 1,
    connect: createGameTlsDuplexConnector({
      openTunnel() {
        throw new Error("private fixture detail");
      },
    }),
  });
  agents.add(agent);
  try {
    await assert.rejects(send(agent), { code: "bridge_offline" });
    assert.equal(server.requests.length, 0);
  } finally {
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("an applied bodyless mutation response is discarded after auth generation changes", async () => {
  let effects = 0;
  let authGeneration = 1;
  let admissionChecks = 0;
  let directCalls = 0;
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      effects += 1;
      response.writeHead(204);
      authGeneration = 2;
      response.end();
    },
  });
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("mutation must not fall back to direct transport");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "123456",
      routeEpoch: 4,
      activeDeviceId: "00000000-0000-4000-8000-000000000401",
    }),
    admitMutation: async () => ({
      action: "boss.attack",
      commandId: "command-attack-bodyless-generation",
      attemptId: "attempt-attack-bodyless-generation",
    }),
    bridgeTransport: createGameApiTunnelTransport({
      openStream: async () => {
        const tunnel = new SocketDuplex(
          createConnection({ host: "127.0.0.1", port }),
        );
        tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000779";
        return tunnel;
      },
      bindMutationConnection: async () => {
        admissionChecks += 1;
        return authGeneration === 1;
      },
      tlsConnect(options) {
        return connectTls({ ...options, ca: cargoCertificate });
      },
    }),
  });
  try {
    await assert.rejects(
      client.request({
        operation: {
          method: "POST",
          path: "/api/bosses/battles/battle-1/attack",
          operationClass: "mutation",
        },
        path: "/api/bosses/battles/battle-1/attack",
        method: "POST",
        headers: {
          Authorization: "Bearer verified.credential",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operationId: operationIdFor(404) }),
        context: { accountId: "123456" },
      }),
      { code: "bridge_transport_failed" },
    );
    assert.equal(effects, 1);
    assert.equal(admissionChecks, 3);
    assert.equal(directCalls, 0);
    assert.equal(server.requests.length, 1);
  } finally {
    await closeCargo(server);
  }
});

test("an arbitrary origin is rejected before opening a tunnel", async () => {
  let tunnelOpened = false;
  const agent = new Agent({
    connections: 1,
    connect: createGameTlsDuplexConnector({
      openTunnel() {
        tunnelOpened = true;
        throw new Error("unexpected");
      },
    }),
  });
  agents.add(agent);
  try {
    await assert.rejects(
      request("https://example.invalid/api/me", { dispatcher: agent }),
      { code: "target_forbidden" },
    );
    assert.equal(tunnelOpened, false);
  } finally {
    await closeAgent(agent);
  }
});

test("a truncated response after application leaves one uncertain attempt", async () => {
  let effects = 0;
  const { server, port } = await startCargo({
    onRequest: async (_requestRecord, response) => {
      effects += 1;
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "40",
      });
      response.write('{"applied":true}');
      response.socket.destroy();
    },
  });
  const agent = createAgent({ port, certificateAuthority: cargoCertificate });
  try {
    await assert.rejects(async () => {
      const response = await send(agent, {
        method: "POST",
        body: JSON.stringify({ action: "fixture" }),
      });
      await response.body.text();
    });
    assert.equal(server.requests.length, 1);
    assert.equal(effects, 1);
  } finally {
    await closeAgent(agent);
    await closeCargo(server);
  }
});

test("malformed or incomplete response headers after application fail the bridge dispatch", async () => {
  for (const [label, rawResponse] of [
    ["partial", "HTTP/1.1 200 OK\r\nContent-Length: "],
    [
      "conflicting-framing",
      "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    ],
  ]) {
    let effects = 0;
    let directCalls = 0;
    const { server, port } = await startCargo({
      onRequest: async (_requestRecord, response) => {
        effects += 1;
        response.socket.end(rawResponse);
      },
    });
    const client = createGameApiClient({
      directTransport: async () => {
        directCalls += 1;
        throw new Error("mutation must not fall back to direct transport");
      },
      resolveRoute: async () => ({
        policy: "bridge_required",
        playerId: "123456",
        routeEpoch: 1,
        activeDeviceId: "00000000-0000-4000-8000-000000000401",
      }),
      admitMutation: async () => ({
        action: "boss.attack",
        commandId: `command-attack-${label}`,
        attemptId: `attempt-attack-${label}`,
      }),
      bridgeTransport: createGameApiTunnelTransport({
        openStream: async () => {
          const tunnel = new SocketDuplex(
            createConnection({ host: "127.0.0.1", port }),
          );
          tunnel.bridgeConnectionId = "00000000-0000-4000-8000-000000000779";
          return tunnel;
        },
        bindMutationConnection: async () => true,
        tlsConnect(options) {
          return connectTls({ ...options, ca: cargoCertificate });
        },
      }),
    });
    try {
      await assert.rejects(
        client.request({
          operation: {
            method: "POST",
            path: "/api/bosses/battles/battle-1/attack",
            operationClass: "mutation",
          },
          path: "/api/bosses/battles/battle-1/attack",
          method: "POST",
          headers: {
            Authorization: "Bearer verified.credential",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            operationId: operationIdFor(label === "partial" ? 405 : 406),
          }),
          context: { accountId: "123456" },
        }),
        { code: "bridge_transport_failed" },
      );
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0].method, "POST");
      assert.equal(effects, 1);
      assert.equal(directCalls, 0);
    } finally {
      await closeCargo(server);
    }
  }
});

test("parallel owners keep credentials and TLS egress on their selected devices", async () => {
  let ownerACargo;
  let ownerBCargo;
  try {
    ownerACargo = await startCargo({
      onRequest: async (requestRecord, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            cargo: "owner-a",
            authorization: requestRecord.authorization,
          }),
        );
      },
    });
    ownerBCargo = await startCargo({
      onRequest: async (requestRecord, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            cargo: "owner-b",
            authorization: requestRecord.authorization,
          }),
        );
      },
    });
    const routes = {
      123456: {
        activeDeviceId: "00000000-0000-4000-8000-000000000401",
        connectionId: "00000000-0000-4000-8000-000000000411",
        port: ownerACargo.port,
        authorization: "Bearer owner-a-token",
        expectedCargo: "owner-a",
      },
      654321: {
        activeDeviceId: "00000000-0000-4000-8000-000000000402",
        connectionId: "00000000-0000-4000-8000-000000000412",
        port: ownerBCargo.port,
        authorization: "Bearer owner-b-token",
        expectedCargo: "owner-b",
      },
    };
    const directCalls = [];
    const openedRoutes = [];
    const client = createGameApiClient({
      directTransport: async (...args) => {
        directCalls.push(args);
        throw new Error("bridge-required read must not use direct transport");
      },
      resolveRoute: async ({ accountId }) => {
        const target = routes[accountId];
        assert.ok(target);
        return {
          policy: "bridge_required",
          playerId: accountId,
          routeEpoch: 1,
          activeDeviceId: target.activeDeviceId,
        };
      },
      bridgeTransport: createGameApiTunnelTransport({
        openStream: async ({ route }) => {
          const target = Object.values(routes).find(
            (candidate) => candidate.activeDeviceId === route.activeDeviceId,
          );
          assert.ok(target);
          openedRoutes.push(route.activeDeviceId);
          const tunnel = new SocketDuplex(
            createConnection({ host: "127.0.0.1", port: target.port }),
          );
          tunnel.bridgeConnectionId = target.connectionId;
          return tunnel;
        },
        tlsConnect(options) {
          return connectTls({ ...options, ca: cargoCertificate });
        },
      }),
    });
    const request = (accountId) =>
      client.request({
        operation: {
          method: "GET",
          path: "/api/me",
          operationClass: "read",
        },
        path: "/api/me",
        method: "GET",
        headers: { Authorization: routes[accountId].authorization },
        context: { accountId },
      });

    const responses = await Promise.all([request("123456"), request("654321")]);
    const values = await Promise.all(
      responses.map((response) => response.json()),
    );

    assert.deepEqual(values, [
      { cargo: "owner-a", authorization: "Bearer owner-a-token" },
      { cargo: "owner-b", authorization: "Bearer owner-b-token" },
    ]);
    assert.equal(ownerACargo.server.requests.length, 1);
    assert.equal(
      ownerACargo.server.requests[0].authorization,
      "Bearer owner-a-token",
    );
    assert.equal(ownerBCargo.server.requests.length, 1);
    assert.equal(
      ownerBCargo.server.requests[0].authorization,
      "Bearer owner-b-token",
    );
    assert.deepEqual(openedRoutes.sort(), [
      routes["123456"].activeDeviceId,
      routes["654321"].activeDeviceId,
    ]);
    assert.equal(directCalls.length, 0);
  } finally {
    if (ownerACargo) await closeCargo(ownerACargo.server);
    if (ownerBCargo) await closeCargo(ownerBCargo.server);
  }
});
