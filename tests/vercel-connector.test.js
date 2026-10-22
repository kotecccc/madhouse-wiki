import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createVercelConnectorHandler } from "../scripts/deploy/vercel-connector-handler.mjs";
const wikiOrigin = "https://wiki.example";
const legacyWikiOrigin = "https://legacy-wiki.example";
const connectorOrigin = "https://connect.example";
const settings = { apiId: 123456, apiHash: "a".repeat(32) }; // Synthetic app parameters.
const initData = "hash=" + "0".repeat(64) + "&user=%7B%7D&auth_date=1";
function response() {
  return {
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(body) {
      this.body = body;
    },
  };
}
async function invoke(
  endpoint,
  {
    method = "GET",
    origin = connectorOrigin,
    query = "",
    body,
    parsed = false,
    appParams = () => settings,
    wikiOrigins = [wikiOrigin],
    fetcher,
  } = {},
) {
  const req = Readable.from(
    body === undefined
      ? []
      : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))],
  );
  req.method = method;
  req.url = endpoint + query;
  req.headers = {
    origin,
    "content-type": "application/json",
    authorization: "Bearer old-token",
    cookie: "private-cookie",
  };
  if (parsed) req.body = body;
  const res = response();
  await createVercelConnectorHandler({
    wikiOrigin,
    wikiOrigins,
    connectorOrigin,
    endpoint,
    appParams,
    fetcher,
  })(req, res);
  return res;
}
test("Vercel config uses runtime params, exact Wiki origin, CSP and no private cache", async () => {
  const r = await invoke("/api/config");
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), {
    ...settings,
    wikiOrigins: [wikiOrigin],
  });
  assert.match(r.headers["cache-control"], /private, no-store/);
  assert.equal(r.headers["vercel-cdn-cache-control"], "no-store");
  assert.match(
    r.headers["content-security-policy"],
    /frame-ancestors https:\/\/wiki.example https:\/\/web.telegram.org/,
  );
  assert.equal(
    (await invoke("/api/config", { appParams: () => ({}) })).statusCode,
    503,
  );
});
test("Vercel connector accepts only the configured current and legacy Wiki origins", async () => {
  const wikiOrigins = [wikiOrigin, legacyWikiOrigin];
  const r = await invoke("/api/config", { wikiOrigins });
  assert.deepEqual(JSON.parse(r.body).wikiOrigins, wikiOrigins);
  for (const origin of wikiOrigins) {
    assert.ok(r.headers["content-security-policy"].includes(origin));
  }
  assert.equal(
    r.headers["content-security-policy"].includes("https://unrelated.example"),
    false,
  );
  const unrelated = await invoke("/api/game-session", {
    method: "POST",
    origin: "https://unrelated.example",
    wikiOrigins,
    body: {},
  });
  assert.equal(unrelated.statusCode, 403);
});
test("Vercel streamed and parsed bodies preserve shared game auth without old Bearer or cookies", async () => {
  for (const parsed of [false, true]) {
    let call;
    const r = await invoke("/api/game-session", {
      method: "POST",
      body: { initData },
      parsed,
      fetcher: async (url, opts) => {
        call = { url, opts };
        return new Response(
          JSON.stringify({ accessToken: "synthetic.payload.signature" }),
        );
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).accessToken, "synthetic.payload.signature");
    assert.equal(call.url, "https://cargohustle.online/api/auth/telegram");
    assert.deepEqual(JSON.parse(call.opts.body), { initData });
    assert.deepEqual(call.opts.headers, {
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    assert.equal(call.opts.redirect, "error");
    assert.equal(r.headers["set-cookie"], undefined);
  }
});
test("Vercel adapter preserves rejected origins, query, methods, bodies and unknown API behavior", async () => {
  const cases = [
    [
      "/api/game-session",
      { method: "POST", origin: "https://evil.example", body: {} },
      403,
    ],
    ["/api/game-session", { method: "POST", query: "?x=1", body: {} }, 403],
    ["/api/game-session", {}, 405],
    ["/api/game-session", { method: "POST", body: {} }, 400],
    ["/api/game-session", { method: "POST", body: "x".repeat(17000) }, 400],
    ["/api/unknown", {}, 404],
  ];
  for (const [endpoint, options, status] of cases) {
    const r = await invoke(endpoint, {
      ...options,
      fetcher: () => {
        throw Error("unexpected upstream");
      },
    });
    assert.equal(r.statusCode, status);
    assert.match(r.headers["cache-control"], /no-store/);
    assert.ok(r.headers["content-security-policy"]);
  }
});
