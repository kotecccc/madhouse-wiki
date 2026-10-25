import assert from "node:assert/strict";
import test from "node:test";
import { fetchPreviewImage } from "./inline-preview-assets.mjs";

test("bounded preview image fetch accepts an image response", async () => {
  const result = await fetchPreviewImage(
    "https://cdn.cargohustle.online/V3/items/1.webp",
    {
      fetchImpl: async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/webp" },
        }),
    },
  );
  assert.equal(result.reason, null);
  assert.equal(result.asset.contentType, "image/webp");
  assert.deepEqual([...result.asset.body], [1, 2, 3]);
});

test("preview image fetch reports HTTP errors and rejects other origins", async () => {
  const response = await fetchPreviewImage(
    "https://cdn.cargohustle.online/V3/items/1.webp",
    { fetchImpl: async () => new Response("missing", { status: 404 }) },
  );
  const origin = await fetchPreviewImage("https://example.com/image.webp");
  assert.equal(response.asset, null);
  assert.match(response.reason, /^http_404_/u);
  assert.deepEqual(origin, { asset: null, reason: "origin_not_allowed" });
});

test("preview image fetch bounds hanging requests", async () => {
  const result = await fetchPreviewImage(
    "https://cdn.cargohustle.online/V3/items/1.webp",
    {
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  assert.equal(result.asset, null);
  assert.equal(result.reason, "TimeoutError");
});
