import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createBlobSessionStore } from "../connector/blob-session-store.js";

test("private storage read can abort a stalled response", async () => {
  let requestSeen;
  const requestStarted = new Promise((resolve) => {
    requestSeen = resolve;
  });
  const server = createServer((_request, _response) => requestSeen());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const oldOrigin = process.env.MADHOUSE_STORAGE_ORIGIN;
  const oldToken = process.env.MADHOUSE_STORAGE_TOKEN;
  process.env.MADHOUSE_STORAGE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  process.env.MADHOUSE_STORAGE_TOKEN = "synthetic-storage-token-32-bytes-long";
  try {
    const controller = new AbortController();
    const result = createBlobSessionStore().read("synthetic-path", {
      signal: controller.signal,
    });
    await requestStarted;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
  } finally {
    if (oldOrigin === undefined) delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = oldOrigin;
    if (oldToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = oldToken;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
