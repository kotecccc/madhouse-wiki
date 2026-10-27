import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { createVercelConnectorHandler } from "../scripts/deploy/vercel-connector-handler.mjs";
const wikiOrigin = "https://wiki.example";
const legacyWikiOrigin = "https://legacy-wiki.example";
const connectorOrigin = "https://connect.example";
const settings = { apiId: 123456, apiHash: "a".repeat(32) }; // Synthetic app parameters.
const testWikiVerificationKey = "11".repeat(32);
const initData =
  "hash=" + "0".repeat(64) + "&user=%7B%22id%22%3A42%7D&auth_date=1";
function signedWikiInitData(id = 42) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id }),
    signature: "synthetic-wiki-signature-field",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  params.set(
    "hash",
    createHmac("sha256", Buffer.from(testWikiVerificationKey, "hex"))
      .update(check)
      .digest("hex"),
  );
  return params.toString();
}
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
    wikiVerificationKey = testWikiVerificationKey,
    fetcher,
    accountSessions,
    wikiFetcher = async (_url, options) =>
      Response.json({
        requestId: JSON.parse(options.body).requestId,
        operation: "device.list",
        devices: [],
        routePolicy: null,
      }),
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
    wikiVerificationKey,
    fetcher,
    accountSessions,
    wikiFetcher,
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
test("Vercel streamed and parsed bodies delegate game auth to Wiki without old Bearer or cookies", async () => {
  for (const parsed of [false, true]) {
    const wikiCalls = [];
    const r = await invoke("/api/game-session", {
      method: "POST",
      body: { initData, wikiInitData: signedWikiInitData() },
      parsed,
      fetcher: async () => assert.fail("Cargo auth must stay on the Wiki"),
      wikiFetcher: async (url, options) => {
        const request = JSON.parse(options.body);
        wikiCalls.push({ url, options, request });
        return Response.json(
          request.operation === "device.list"
            ? {
                requestId: request.requestId,
                operation: request.operation,
                devices: [],
                routePolicy: null,
              }
            : {
                requestId: request.requestId,
                operation: request.operation,
                operationId: "00000000-0000-4000-8000-000000000001",
                status: "ready",
              },
        );
      },
    });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(JSON.parse(r.body), {
      status: "connected",
      serverManaged: true,
    });
    assert.equal(wikiCalls.length, 2);
    assert.ok(wikiCalls.every(({ url }) => url === `${wikiOrigin}/api/bridge`));
    assert.equal(wikiCalls[1].request.operation, "game_auth.bootstrap");
    assert.equal(wikiCalls[1].request.cargoLaunchData, initData);
    assert.deepEqual(wikiCalls[1].options.headers, {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: wikiOrigin,
    });
    assert.equal(wikiCalls[1].options.credentials, "omit");
    assert.equal(wikiCalls[1].options.redirect, "error");
    assert.equal(Object.hasOwn(JSON.parse(r.body), "accessToken"), false);
    assert.equal(r.headers["set-cookie"], undefined);
  }
});
test("Vercel rejects legacy account-session saves without calling Wiki or storage", async () => {
  let wikiCalls = 0;
  let accountSessionCalls = 0;
  const r = await invoke("/api/account-session", {
    method: "POST",
    body: {
      action: "save",
      wikiInitData: signedWikiInitData(),
      ticket: "1.synthetic-ticket",
      accessToken: "candidate.token.signature",
    },
    wikiFetcher: async () => {
      wikiCalls += 1;
      assert.fail("legacy account-session save must not call Wiki");
    },
    accountSessions: async () => {
      accountSessionCalls += 1;
      assert.fail("legacy account-session save must not call storage");
    },
  });

  assert.equal(r.statusCode, 409);
  assert.deepEqual(JSON.parse(r.body), {
    error: "game_auth_server_managed_required",
  });
  assert.equal(wikiCalls, 0);
  assert.equal(accountSessionCalls, 0);
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
