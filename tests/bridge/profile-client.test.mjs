import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import {
  readGameOverBridge,
  readProfileOverBridge,
  sendWorkTaskOverBridge,
  sendFriendResponseOverBridge,
} from "../../scripts/bridge/profile-client.mjs";
import { createGameTlsDuplexConnector } from "../../scripts/bridge/tls-duplex-connector.mjs";

const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);

test("work task transport rejects missing permission and altered payload", () => {
  const request = {
    authorization: "Bearer fake",
    method: "POST",
    path: "/api/works/tasks/perform",
    body: JSON.stringify({
      workId: 7,
      taskId: 2,
      locale: "ru",
      operationId: "op-1",
    }),
  };
  assert.throws(() => sendWorkTaskOverBridge(request), {
    message: "invalid_work_action",
  });
  assert.throws(
    () =>
      sendWorkTaskOverBridge({
        ...request,
        validateTunnel: () => true,
        body: '{"workId":7,"taskId":2,"locale":"ru","operationId":"op-1","extra":true}',
      }),
    { message: "invalid_work_action" },
  );
  assert.throws(
    () =>
      sendWorkTaskOverBridge({
        ...request,
        validateTunnel: () => true,
        path: "/api/me/bag/boosters/buy",
      }),
    { message: "invalid_work_action" },
  );
});

test("queued action checks permission after TLS before sending any bytes", async () => {
  let requests = 0;
  const server = createServer({ cert, key }, (_req, res) => {
    requests++;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const validateTunnel = () => false;
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
    validateTunnel,
  });
  try {
    await assert.rejects(
      sendFriendResponseOverBridge({
        authorization: "Bearer fake-token",
        method: "POST",
        path: "/api/friends/requests/42/accept",
        validateTunnel,
        connector,
      }),
      { code: "bridge_mutation_not_admitted" },
    );
    assert.equal(requests, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("work view accepts only the bounded read request over the verified tunnel", async () => {
  let seen;
  const server = createServer({ cert, key }, async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    seen = {
      method: req.method,
      url: req.url,
      body: JSON.parse(Buffer.concat(parts)),
    };
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    const request = {
      authorization: "Bearer fake-token",
      path: "/api/works/open",
      method: "POST",
      body: JSON.stringify({ workId: 7, locale: "ru" }),
      connector,
    };
    assert.equal((await readGameOverBridge(request)).status, 200);
    assert.deepEqual(seen, {
      method: "POST",
      url: "/api/works/open",
      body: { workId: 7, locale: "ru" },
    });
    for (const body of [
      '{"workId":7,"locale":"ru","action":true}',
      '{"workId":0,"locale":"ru"}',
      "{}",
    ])
      assert.throws(() => readGameOverBridge({ ...request, body }), {
        message: "invalid_profile_request",
      });
    assert.throws(
      () => readGameOverBridge({ ...request, path: "/api/works/open?x=1" }),
      { message: "invalid_profile_request" },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("selected game reads preserve their query inside the verified tunnel", async () => {
  let seen;
  const server = createServer({ cert, key }, (req, res) => {
    seen = {
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
    };
    res.end('{"items":[]}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    const result = await readGameOverBridge({
      authorization: "Bearer fake-token",
      path: "/api/friends/search?name=test",
      connector,
    });
    assert.equal(result.status, 200);
    assert.deepEqual(seen, {
      url: "/api/friends/search?name=test",
      method: "GET",
      authorization: "Bearer fake-token",
    });
    for (const path of [
      "/api/auth",
      "https://evil.test/api/me",
      "/api/me#fragment",
      "/api/me%2fextra",
    ])
      assert.throws(
        () =>
          readGameOverBridge({
            authorization: "Bearer fake-token",
            path,
            connector,
          }),
        { message: "invalid_profile_request" },
      );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reads only the fake profile over verified TLS and sends the token inside it", async () => {
  let seen;
  const server = createServer({ cert, key }, (req, res) => {
    seen = {
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"profile":"fake"}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    const result = await readProfileOverBridge({
      authorization: "Bearer fake-token",
      connector,
    });
    assert.deepEqual(seen, {
      url: "/api/me",
      method: "GET",
      authorization: "Bearer fake-token",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), '{"profile":"fake"}');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an offline tunnel fails without a direct request", async () => {
  let opened = 0;
  await assert.rejects(
    readProfileOverBridge({
      authorization: "Bearer fake-token",
      openTunnel: () => {
        opened += 1;
        throw new Error("offline");
      },
    }),
    { code: "bridge_offline" },
  );
  assert.equal(opened, 1);
});

test("rejects malformed credentials before opening a tunnel", () => {
  let opened = false;
  assert.throws(
    () =>
      readProfileOverBridge({
        authorization: "Bearer fake\r\nInjected: header",
        openTunnel: () => {
          opened = true;
        },
      }),
    { message: "invalid_profile_request" },
  );
  assert.equal(opened, false);
});

test("does not follow a redirect or forward the credential to another host", async () => {
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(302, { Location: "https://elsewhere.invalid/steal" });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let opens = 0;
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => {
      opens += 1;
      return createConnection(server.address().port, "127.0.0.1");
    },
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    const result = await readProfileOverBridge({
      authorization: "Bearer fake-token",
      connector,
    });
    assert.equal(result.status, 302);
    assert.equal(opens, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects a truncated profile rather than treating it as a result", async () => {
  const server = createServer({ cert, key }, (_req, res) => {
    res.writeHead(200, { "Content-Length": "100" });
    res.write("partial");
    res.socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    await assert.rejects(
      readProfileOverBridge({ authorization: "Bearer fake-token", connector }),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
