import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createWikiAnalyticsApi,
  createWikiAnalyticsCleanupApi,
} from "../scripts/analytics/wiki-analytics-api.mjs";
import {
  createWikiAnalyticsStore,
  deriveVisitorKey,
  verifyCronAuthorization,
} from "../scripts/analytics/wiki-analytics-store.mjs";

const token = "123456:fake-test-token";
const adminId = "99";
const now = new Date("2026-10-21T12:00:00.000Z");

function signedInitData(id) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now.getTime() / 1000)),
    user: JSON.stringify({
      id,
      first_name: "Тест",
      username: `wiki_${id}`,
    }),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function request(body, method = "POST") {
  return new Request("https://wiki.example/api/analytics", {
    method,
    headers: { "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

function makeBlobClient() {
  const files = new Map();
  let version = 0;
  return {
    files,
    async put(pathname, content, options = {}) {
      const existing = files.get(pathname);
      if (options.ifMatch && existing?.etag !== options.ifMatch)
        throw new Error("etag_mismatch");
      if (options.allowOverwrite === false && existing)
        throw new Error("already_exists");
      const etag = `"analytics-${++version}"`;
      files.set(pathname, { content: String(content), etag });
      return { pathname, etag };
    },
    async get(pathname) {
      const entry = files.get(pathname);
      if (!entry) return null;
      const body = Buffer.from(entry.content);
      return {
        statusCode: 200,
        blob: { size: body.length, etag: entry.etag },
        stream: new Response(body).body,
      };
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      const names = [...files.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      const start = Number(cursor || 0);
      const page = names.slice(start, start + limit);
      const next = start + page.length;
      return {
        blobs: page.map((pathname) => ({ pathname })),
        hasMore: next < names.length,
        cursor: next < names.length ? String(next) : undefined,
      };
    },
    async del(pathOrPaths, options = {}) {
      for (const pathname of Array.isArray(pathOrPaths)
        ? pathOrPaths
        : [pathOrPaths]) {
        const entry = files.get(pathname);
        if (options.ifMatch && entry?.etag !== options.ifMatch)
          throw new Error("etag_mismatch");
        files.delete(pathname);
      }
    },
  };
}

test("analytics accepts only allowlisted events, records consented Telegram identity and protects reports", async () => {
  const calls = { append: [], deleted: [], report: [] };
  const store = {
    append: async (...args) => calls.append.push(args),
    deleteVisitor: async (key) => {
      calls.deleted.push(key);
      return 2;
    },
    report: async (options) => {
      calls.report.push(options);
      return { events: 1, visitors: [] };
    },
  };
  const api = createWikiAnalyticsApi({
    botToken: token,
    adminTelegramId: adminId,
    store,
    now: () => now,
  });
  const accepted = await api(
    request({
      action: "events",
      initData: signedInitData(55),
      events: [
        {
          event: "floor_select",
          section: "floors",
          feature: "floor_catalogue",
          subject: "A",
        },
      ],
    }),
  );
  assert.equal(accepted.status, 202);
  assert.equal(
    calls.append[0][0],
    deriveVisitorKey(token, { kind: "telegram", id: "55" }),
  );
  assert.deepEqual(calls.append[0][2], {
    telegramId: "55",
    username: "wiki_55",
  });
  assert.equal(
    (
      await api(
        request({
          action: "events",
          visitorId: "550e8400-e29b-41d4-a716-446655440000",
          events: [{ event: "unknown" }],
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await api(
        request({
          action: "events",
          initData: "",
          visitorId: "550e8400-e29b-41d4-a716-446655440000",
          events: [{ event: "app_open" }],
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await api(request({ action: "report", initData: signedInitData(55) })))
      .status,
    403,
  );
  assert.equal(
    (await api(request({ action: "report", initData: signedInitData(99) })))
      .status,
    200,
  );
  assert.deepEqual(calls.report[0], {
    excludeVisitorKey: deriveVisitorKey(token, {
      kind: "telegram",
      id: adminId,
    }),
  });
  const adminEvents = await api(
    request({
      action: "events",
      initData: signedInitData(99),
      events: [{ event: "app_open", section: "floors" }],
    }),
  );
  assert.deepEqual(await adminEvents.json(), { accepted: 0 });
  assert.equal(calls.append.length, 1);
  const deleted = await api(
    request({ action: "delete-self", initData: signedInitData(55) }),
  );
  assert.deepEqual(await deleted.json(), { deletedEvents: 2 });
  assert.equal(calls.deleted[0], calls.append[0][0]);
});

test("private Blob store batches events, reports Telegram identity, filters admin events, deletes data and expires old files", async () => {
  const blobClient = makeBlobClient();
  let current = new Date("2026-07-01T12:00:00.000Z");
  const store = createWikiAnalyticsStore({ blobClient, now: () => current });
  const visitor = deriveVisitorKey(token, {
    kind: "telegram",
    id: "55",
  });
  await store.append(
    visitor,
    [
      { event: "app_open", section: "floors", feature: "floor_catalogue" },
      {
        event: "floor_select",
        section: "floors",
        feature: "floor_catalogue",
        subject: "A",
      },
    ],
    { telegramId: "55", username: "wiki_55", displayName: "Не сохранять" },
  );
  current = new Date("2026-07-02T12:00:00.000Z");
  await store.append(visitor, [
    { event: "app_open", section: "floors", feature: "floor_catalogue" },
  ]);
  const adminVisitor = deriveVisitorKey(token, {
    kind: "telegram",
    id: "99",
  });
  await store.append(adminVisitor, [{ event: "app_open", section: "floors" }], {
    telegramId: "99",
    username: "admin_99",
  });
  const report = await store.report({ excludeVisitorKey: adminVisitor });
  assert.equal(report.events, 3);
  assert.equal(report.visits, 2);
  assert.equal(report.uniqueVisitors, 1);
  assert.deepEqual(report.bySubject, [{ name: "floor_catalogue/A", count: 1 }]);
  assert.equal(report.daily.length, 2);
  assert.match(report.visitors[0].visitor, /^user-[a-f0-9]{8}$/u);
  assert.equal(report.visitors[0].telegramId, "55");
  assert.equal(report.visitors[0].username, "wiki_55");
  assert.equal(JSON.stringify(blobClient.files).includes("displayName"), false);
  assert.equal(
    JSON.stringify(blobClient.files).includes("Не сохранять"),
    false,
  );
  assert.equal(JSON.stringify(report).includes(visitor), false);
  assert.equal(await store.deleteVisitor(visitor), 3);
  assert.equal(await store.deleteVisitor(adminVisitor), 1);
  assert.equal(blobClient.files.size, 0);

  await store.append(visitor, [{ event: "app_open", section: "floors" }]);
  current = new Date("2026-10-21T12:00:00.000Z");
  assert.deepEqual(await store.cleanExpired(), {
    deleted: 1,
    truncated: false,
  });
});

test("analytics persists only consented verified Telegram identifiers, never initData or profile names", async () => {
  const blobClient = makeBlobClient();
  const store = createWikiAnalyticsStore({ blobClient, now: () => now });
  const api = createWikiAnalyticsApi({
    botToken: token,
    adminTelegramId: adminId,
    store,
    now: () => now,
  });
  const initData = signedInitData(55);
  const response = await api(
    request({
      action: "events",
      initData,
      events: [{ event: "app_open", section: "floors" }],
    }),
  );
  assert.equal(response.status, 202);
  const stored = JSON.stringify(
    [...blobClient.files.values()].map((entry) => JSON.parse(entry.content)),
  );
  assert.match(stored, /"telegramId":"55"/u);
  assert.match(stored, /"username":"wiki_55"/u);
  assert.equal(stored.includes(initData), false);
  assert.equal(stored.includes("first_name"), false);
  assert.equal(stored.includes("Тест"), false);
});

test("analytics cleanup requires the configured Vercel Cron bearer secret", async () => {
  assert.equal(
    verifyCronAuthorization("Bearer test-secret", "test-secret"),
    true,
  );
  assert.equal(verifyCronAuthorization("Bearer wrong", "test-secret"), false);
  const api = createWikiAnalyticsCleanupApi({
    cronSecret: "test-secret",
    store: { cleanExpired: async () => ({ deleted: 4, truncated: false }) },
  });
  assert.equal(
    (await api(new Request("https://wiki.example/api/analytics-cleanup")))
      .status,
    401,
  );
  const response = await api(
    new Request("https://wiki.example/api/analytics-cleanup", {
      headers: { authorization: "Bearer test-secret" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: 4, truncated: false });
});
