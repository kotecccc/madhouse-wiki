import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installCatalogueCapture } from "../scripts/catalogue/proxy-capture.mjs";

function response(
  proxy,
  {
    path = "/api/bosses/7",
    status = 200,
    body = { id: 7 },
    method = "GET",
  } = {},
) {
  const upstream = Object.assign(new EventEmitter(), {
    statusCode: status,
    headers: { "content-type": "application/json" },
  });
  proxy.emit("proxyRes", upstream, { method, url: path });
  upstream.emit("data", Buffer.from(JSON.stringify(body)));
  upstream.emit("end");
}

test("catalogue capture opens no SQLite connection at startup and closes each writer after its response", () => {
  const proxy = new EventEmitter();
  const calls = [];
  let opened = 0;
  let closed = 0;
  const capture = installCatalogueCapture(proxy, "/fixture", {
    createStore: (root) => {
      assert.equal(root, "/fixture");
      opened++;
      return {
        initialize() {},
        capture: (...args) => calls.push(args),
        close: () => closed++,
      };
    },
  });
  assert.equal(opened, 0);
  response(proxy);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  response(proxy, { path: "/api/businesses/2", body: { id: 2 } });
  assert.equal(opened, 2);
  assert.equal(closed, 2);
  assert.deepEqual(calls, [
    ["/api/bosses/7", 200, { id: 7 }],
    ["/api/businesses/2", 200, { id: 2 }],
  ]);
  capture.close();
  response(proxy);
  assert.equal(opened, 2);
});

test("error responses also release their writer; non-reference routes never open one", () => {
  const proxy = new EventEmitter();
  let closed = 0;
  const calls = [];
  installCatalogueCapture(proxy, "/fixture", {
    createStore: () => ({
      initialize() {},
      capture: (...args) => calls.push(args),
      close: () => closed++,
    }),
  });
  response(proxy, { path: "/api/me" });
  response(proxy, { method: "POST" });
  assert.equal(closed, 0);
  response(proxy, { status: 500, body: { private: "ignored" } });
  assert.equal(closed, 1);
  assert.deepEqual(calls, [["/api/bosses/7", 500, null]]);
});

test("failed capture closes its writer and logs only the reference route", () => {
  const proxy = new EventEmitter();
  const messages = [];
  const original = console.error;
  let closed = 0;
  console.error = (...args) => messages.push(args);
  try {
    installCatalogueCapture(proxy, "/fixture", {
      createStore: () => ({
        initialize() {},
        capture() {
          throw new Error("private payload");
        },
        close: () => closed++,
      }),
    });
    assert.doesNotThrow(() => response(proxy));
    assert.equal(closed, 1);
    assert.equal(messages.length, 1);
    assert.equal(JSON.stringify(messages).includes("private payload"), false);
  } finally {
    console.error = original;
  }
});
