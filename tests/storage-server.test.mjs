import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createStorageServer } from "../scripts/storage/server.mjs";

const token = "test-storage-token-that-is-at-least-32-bytes";

async function withServer(run) {
  const root = mkdtempSync(join(tmpdir(), "madhouse-storage-test-"));
  const server = createStorageServer({ root, token, port: 0 });
  await once(server, "listening");
  const { port } = server.address();
  const call = (path, options = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(options.auth === false ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  try {
    await run({ call, root });
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
}

test("storage API requires authentication and only exposes the exact allowlist", async () => {
  await withServer(async ({ call }) => {
    const unauthorized = await call(
      "/v1/objects/madhouse-wiki/catalogue/reference.sqlite",
      {
        auth: false,
      },
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    for (const path of [
      "/v1/objects/../../secret",
      "/v1/objects/%2e%2e%2fsecret",
      "/v1/objects/madhouse-wiki/catalogue/other.sqlite",
      "/v1/objects/madhouse-raids/telegram-session.enc.json/extra",
    ]) {
      assert.equal((await call(path)).status, 404, path);
    }
    assert.equal(
      (await call("/v1/objects/madhouse-raids/schedule.json")).status,
      404,
    );
  });
});

test("conditional writes return strong SHA-256 etags and persist across restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-storage-restart-"));
  let server = createStorageServer({ root, token, port: 0 });
  await once(server, "listening");
  let url = `http://127.0.0.1:${server.address().port}/v1/objects/madhouse-raids/schedule.json`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    const created = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "if-none-match": "*" },
      body: "first",
    });
    assert.equal(created.status, 200);
    const etag = created.headers.get("etag");
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers, "if-none-match": "*" },
          body: "loser",
        })
      ).status,
      412,
    );
    server.close();
    await once(server, "close");

    server = createStorageServer({ root, token, port: 0 });
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}/v1/objects/madhouse-raids/schedule.json`;
    const loaded = await fetch(url, { headers });
    assert.equal(await loaded.text(), "first");
    assert.equal(loaded.headers.get("etag"), etag);
    assert.equal(
      loaded.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(
      (
        await fetch(url, {
          method: "PUT",
          headers: { ...headers, "if-match": '"stale"' },
          body: "bad",
        })
      ).status,
      412,
    );
    const updated = await fetch(url, {
      method: "PUT",
      headers: { ...headers, "if-match": etag },
      body: "second",
    });
    assert.equal(updated.status, 200);
    assert.equal(
      readFileSync(join(root, "madhouse-raids/schedule.json"), "utf8"),
      "second",
    );
    assert.equal(
      statSync(join(root, "madhouse-raids/schedule.json")).mode & 0o777,
      0o600,
    );
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-object request limits are enforced", async () => {
  await withServer(async ({ call }) => {
    const oversized = await call("/v1/objects/madhouse-raids/sync-lock.json", {
      method: "PUT",
      headers: { "if-none-match": "*", "content-length": "2049" },
      body: Buffer.alloc(2049),
    });
    assert.equal(oversized.status, 413);
    assert.equal(
      (
        await call("/v1/objects/madhouse-raids/telegram-session.enc.json", {
          method: "PUT",
          headers: { "if-none-match": "*" },
          body: Buffer.alloc(16 * 1024 + 1),
        })
      ).status,
      413,
    );
  });
});

test("simultaneous create requests allow only one conditional winner", async () => {
  await withServer(async ({ call }) => {
    const options = (body) => ({
      method: "PUT",
      headers: { "if-none-match": "*" },
      body,
    });
    const results = await Promise.all([
      call("/v1/objects/madhouse-raids/sync-lock.json", options("one")),
      call("/v1/objects/madhouse-raids/sync-lock.json", options("two")),
    ]);
    assert.deepEqual(
      results.map((response) => response.status).sort(),
      [200, 412],
    );
  });
});
