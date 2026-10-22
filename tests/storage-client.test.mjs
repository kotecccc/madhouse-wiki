import assert from "node:assert/strict";
import test from "node:test";
import {
  BlobPreconditionFailedError,
  get,
  put,
} from "../scripts/storage/client.mjs";

const savedOrigin = process.env.MADHOUSE_STORAGE_ORIGIN;
const savedToken = process.env.MADHOUSE_STORAGE_TOKEN;

function configure() {
  process.env.MADHOUSE_STORAGE_ORIGIN =
    "https://storage.example/_madhouse-storage";
  process.env.MADHOUSE_STORAGE_TOKEN = "x".repeat(32);
}

test("private storage GET preserves etag and maps 404 to null", async (t) => {
  configure();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedOrigin === undefined) delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = savedOrigin;
    if (savedToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = savedToken;
  });

  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return new Response("{}", {
      status: 200,
      headers: { etag: '"raw-tag"', "content-length": "2" },
    });
  };
  const result = await get("madhouse-raids/schedule.json", { useCache: false });
  assert.equal(result.statusCode, 200);
  assert.equal(result.blob.etag, '"raw-tag"');
  assert.equal(result.blob.size, 2);
  assert.equal(await new Response(result.stream).text(), "{}");
  assert.equal(
    seen.url,
    "https://storage.example/_madhouse-storage/v1/objects/madhouse-raids%2Fschedule.json",
  );
  assert.equal(seen.init.headers.authorization, `Bearer ${"x".repeat(32)}`);
  assert.equal(seen.init.redirect, "error");

  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(await get("madhouse-raids/missing.json"), null);
});

test("PUT maps compare-and-swap options to HTTP conditional headers", async (t) => {
  configure();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedOrigin === undefined) delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = savedOrigin;
    if (savedToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = savedToken;
  });

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(null, { status: 200, headers: { etag: '"next"' } });
  };
  const created = await put("lock.json", "new", {
    allowOverwrite: false,
    contentType: "application/json",
  });
  await put("lock.json", "replace", { allowOverwrite: true, ifMatch: '"old"' });
  assert.equal(requests[0].init.headers["if-none-match"], "*");
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.equal(requests[1].init.headers["if-match"], '"old"');
  assert.equal(requests[1].init.headers["if-none-match"], undefined);
  assert.equal(created.etag, '"next"');

  globalThis.fetch = async () => new Response(null, { status: 412 });
  await assert.rejects(
    put("lock.json", "stale", { allowOverwrite: true, ifMatch: '"old"' }),
    (error) => error instanceof BlobPreconditionFailedError,
  );
});

test("configured storage rejects insecure origins and incomplete credentials", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedOrigin === undefined) delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = savedOrigin;
    if (savedToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = savedToken;
  });
  globalThis.fetch = async () => assert.fail("fetch should not run");

  process.env.MADHOUSE_STORAGE_ORIGIN = "http://storage.example";
  process.env.MADHOUSE_STORAGE_TOKEN = "x".repeat(32);
  await assert.rejects(get("private"), /madhouse_storage_config_unavailable/);

  process.env.MADHOUSE_STORAGE_ORIGIN = "https://storage.example";
  process.env.MADHOUSE_STORAGE_TOKEN = "short";
  await assert.rejects(get("private"), /madhouse_storage_config_unavailable/);
});
