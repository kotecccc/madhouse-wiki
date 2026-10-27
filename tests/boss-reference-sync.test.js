import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { createCatalogueSyncApi } from "../scripts/catalogue/sync-api.mjs";
import { legacyDirectRouteResolver } from "../scripts/bridge/game-api-client.mjs";

const ROOT = process.cwd();
const AUTH = `Bearer ${"x".repeat(24)}`;

async function fixture(t, fetcher, routeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "boss-reference-sync-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "catalogue.sqlite");
  const store = new CatalogueStore(ROOT, file);
  store.capture("/api/bosses/49", 200, { id: 49, name: "Начальный босс" });
  store.close();

  const storeBlob = {
    download: async () => ({ file, etag: "local", mutable: true }),
  };
  const api = createCatalogueSyncApi({
    root: ROOT,
    storeBlob,
    fetcher,
    resolveRoute: legacyDirectRouteResolver,
    ...routeOptions,
  });
  return { api, file, storeBlob };
}

function request(method, path = "/api/catalogue?bossId=49", body) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(method === "POST" ? { Authorization: AUTH } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function body(response) {
  return response.json();
}

test("public boss read exposes uncaptured state, sync persists only currency preview", async (t) => {
  let fetchCount = 0;
  const { api, file } = await fixture(t, async (url) => {
    fetchCount += 1;
    assert.equal(url, "https://cargohustle.online/api/bosses/49");
    return Response.json({
      id: 49,
      name: "Начальный босс",
      rewardPreview: { gold: 120, pills: 2, dollar: 5 },
      wallet: { gold: 999999, pills: 888 },
      privateProfile: { accountId: "secret" },
    });
  });

  const before = await body(await api(request("GET")));
  assert.equal(before.boss.rewardPreviewCaptured, false);
  const response = await api(
    request("POST", "/api/catalogue", { bossId: "49" }),
  );
  assert.equal(response.status, 200);
  const synced = await body(response);
  assert.equal(synced.cached, false);
  assert.deepEqual(synced.boss.rewardPreview, {
    gold: 120,
    pills: 2,
    dollar: 5,
  });
  assert.equal(Object.hasOwn(synced.boss, "wallet"), false);
  assert.equal(Object.hasOwn(synced.boss, "privateProfile"), false);
  assert.equal(synced.boss.rewardPreviewCaptured, true);
  assert.equal(fetchCount, 1);

  const repeated = await body(
    await api(request("POST", "/api/catalogue", { bossId: "49" })),
  );
  assert.equal(repeated.cached, true);
  assert.equal(fetchCount, 1);

  // Reuse the same mutable store through a new API instance.
  const persistedApi = createCatalogueSyncApi({
    root: ROOT,
    storeBlob: {
      download: async () => ({ file, mutable: true }),
    },
    fetcher: async () => {
      throw new Error("should not reach upstream");
    },
    resolveRoute: legacyDirectRouteResolver,
  });
  assert.equal(
    (await body(await persistedApi(request("GET")))).boss.rewardPreviewCaptured,
    true,
  );
  assert.equal(
    (
      await body(
        await persistedApi(request("POST", "/api/catalogue", { bossId: "49" })),
      )
    ).cached,
    true,
  );
});

test("bridge-required catalogue sync fails closed without a bridge transport", async (t) => {
  let fetchCount = 0;
  const { api } = await fixture(
    t,
    async () => {
      fetchCount += 1;
      return Response.json({ id: 49 });
    },
    {
      resolveRoute: async () => ({
        policy: "bridge_required",
        activeDeviceId: "123e4567-e89b-42d3-a456-426614174000",
        routeEpoch: 1,
      }),
    },
  );

  const response = await api(
    request("POST", "/api/catalogue", { bossId: "49" }),
  );
  assert.equal(response.status, 503);
  assert.equal((await body(response)).error, "boss_reference_sync_unavailable");
  assert.equal(fetchCount, 0);
});

test("bridge-required boss reference sync uses the reviewed Cargo read operation", async (t) => {
  const requests = [];
  const { api } = await fixture(
    t,
    async () => {
      assert.fail("direct transport must not be used");
    },
    {
      resolveRoute: async () => ({
        policy: "bridge_required",
        activeDeviceId: "123e4567-e89b-42d3-a456-426614174000",
        routeEpoch: 1,
      }),
      bridgeTransport: async (request) => {
        requests.push(request);
        return Response.json({
          id: 49,
          rewardPreview: { gold: 5, pills: null, dollar: 0 },
        });
      },
    },
  );

  const response = await api(
    request("POST", "/api/catalogue", { bossId: "49" }),
  );
  assert.equal(response.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation.operationClass, "read");
  assert.equal(requests[0].operation.path, "/api/bosses/{bossId}");
  assert.equal(requests[0].path, "/api/bosses/49");
});

test("concurrent same-instance boss requests fetch upstream once", async (t) => {
  let fetchCount = 0;
  const { api } = await fixture(t, async () => {
    fetchCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return Response.json({ id: 49, rewardPreview: { gold: 1 } });
  });
  const responses = await Promise.all([
    api(request("POST", "/api/catalogue", { bossId: "49" })),
    api(request("POST", "/api/catalogue", { bossId: "49" })),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(fetchCount, 1);
});

test("successful responses with absent or null reward preview are durably captured", async (t) => {
  for (const responseBody of [{ id: 49 }, { id: 49, rewardPreview: null }]) {
    let fetchCount = 0;
    const { api } = await fixture(t, async () => {
      fetchCount += 1;
      return Response.json(responseBody);
    });
    const first = await body(
      await api(request("POST", "/api/catalogue", { bossId: "49" })),
    );
    assert.equal(first.cached, false);
    assert.equal(first.boss.rewardPreviewCaptured, true);
    const second = await body(
      await api(request("POST", "/api/catalogue", { bossId: "49" })),
    );
    assert.equal(second.cached, true);
    assert.equal(fetchCount, 1);
  }
});

test("upstream auth and rate-limit failures do not mark the preview captured", async (t) => {
  for (const status of [401, 429]) {
    let fetchCount = 0;
    const { api } = await fixture(t, async () => {
      fetchCount += 1;
      return new Response("", { status });
    });
    const response = await api(
      request("POST", "/api/catalogue", { bossId: "49" }),
    );
    assert.equal(response.status, status);
    assert.equal(
      (await body(await api(request("GET")))).boss.rewardPreviewCaptured,
      false,
    );
    assert.equal(fetchCount, 1);
  }
});

test("invalid bodies, invalid boss IDs, and unknown bosses make no game requests", async (t) => {
  let fetchCount = 0;
  const { api } = await fixture(t, async () => {
    fetchCount += 1;
    return Response.json({ id: 49 });
  });
  for (const invalid of [
    request("POST", "/api/catalogue", { bossId: "../49" }),
    request("POST", "/api/catalogue", { bossId: "49", extra: true }),
  ]) {
    const response = await api(invalid);
    assert.equal(response.status, 400);
  }
  assert.equal(
    (await api(request("POST", "/api/catalogue", { bossId: "50" }))).status,
    404,
  );
  assert.equal(fetchCount, 0);
});

test("production-style immutable SQLite storage uploads once and survives later requests", async (t) => {
  const { file } = await fixture(t, async () => {
    throw new Error("unused");
  });
  let uploads = 0,
    fetches = 0;
  const storeBlob = {
    async download() {
      const directory = await mkdtemp(join(tmpdir(), "boss-blob-copy-"));
      const snapshot = join(directory, "catalogue.sqlite");
      await copyFile(file, snapshot);
      return { directory, file: snapshot, etag: "version-1" };
    },
    async upload(updated, etag) {
      assert.equal(etag, "version-1");
      uploads++;
      await copyFile(updated, file);
    },
  };
  const api = createCatalogueSyncApi({
    root: ROOT,
    storeBlob,
    fetcher: async () => {
      fetches++;
      return Response.json({
        id: 49,
        rewardPreview: { gold: 50, pills: null, dollar: 0 },
      });
    },
    resolveRoute: legacyDirectRouteResolver,
  });
  assert.equal(
    (await api(request("POST", "/api/catalogue", { bossId: "49" }))).status,
    200,
  );
  const saved = await body(await api(request("GET")));
  assert.deepEqual(saved.boss.rewardPreview, {
    gold: 50,
    pills: null,
    dollar: 0,
  });
  assert.equal(saved.boss.rewardPreviewCaptured, true);
  assert.equal(
    (await body(await api(request("POST", "/api/catalogue", { bossId: "49" }))))
      .cached,
    true,
  );
  assert.equal(fetches, 1);
  assert.equal(uploads, 1);
});
