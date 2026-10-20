import test from "node:test";
import assert from "node:assert/strict";
import { createProxy } from "../api/[...path].js";
function response() {
  return {
    headers: {},
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}
test("production proxy rejects writes, unknown destinations and missing sessions without upstream calls", async () => {
  const proxy = createProxy(() => {
    throw new Error("must not fetch");
  });
  for (const [method, url, expected] of [
    ["POST", "/api/me", 405],
    ["GET", "https://evil.test/api/me", 404],
    ["GET", "/api/auth/telegram", 404],
    ["GET", "/api/%2e%2e/me", 404],
    ["GET", "/api/me", 401],
  ]) {
    const res = response();
    await proxy({ method, url, headers: {} }, res);
    assert.equal(res.statusCode, expected);
    assert.match(res.headers["cache-control"], /no-store/);
  }
});
test("production proxy forwards only Bearer and JSON Accept to fixed upstream; never forwards cookies or caches personal data", async () => {
  let call;
  const proxy = createProxy(async (url, options) => {
    call = { url, options };
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "set-cookie": "private=value", "cache-control": "public" },
    });
  });
  const res = response();
  await proxy(
    {
      method: "GET",
      url: "/api/floors/A/info?locale=ru",
      headers: {
        authorization: "Bearer test.session.token",
        cookie: "private=value",
        host: "evil.test",
      },
    },
    res,
  );
  assert.equal(
    call.url,
    "https://cargohustle.online/api/floors/A/info?locale=ru",
  );
  assert.deepEqual(call.options.headers, {
    Authorization: "Bearer test.session.token",
    Accept: "application/json",
  });
  assert.equal(call.options.redirect, "manual");
  assert.equal(call.options.cache, "no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.match(res.headers["vercel-cdn-cache-control"], /no-store/);
});
test("upstream failures preserve status and bounded retry while exceptions expose no secret", async () => {
  for (const status of [401, 403, 429]) {
    const res = response();
    await createProxy(
      async () =>
        new Response("{}", { status, headers: { "retry-after": "15" } }),
    )(
      {
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer fake" },
      },
      res,
    );
    assert.equal(res.statusCode, status);
    if (status === 429) assert.equal(res.headers["retry-after"], "15");
  }
  const res = response();
  await createProxy(async () => {
    throw new Error("secret");
  })(
    {
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer fake" },
    },
    res,
  );
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(String(res.body), /secret/);
  assert.equal(
    res.headers["x-madhouse-transport-error"],
    "upstream-network-failure",
  );
});

test("Sites Fetch transport shares the same route and privacy boundary", async () => {
  const { createProductionApi } =
    await import("../scripts/deploy/production-api.mjs");
  let called = false;
  const transport = createProductionApi(["/api/me"], async (url, options) => {
    called = true;
    assert.equal(url, "https://cargohustle.online/api/me");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Cookie, undefined);
    return new Response("{}", {
      status: 403,
      headers: { "set-cookie": "secret" },
    });
  });
  const denied = await transport(
    new Request("https://wiki.invalid/api/unknown", {
      headers: { Authorization: "Bearer fake" },
    }),
  );
  assert.equal(denied.status, 404);
  assert.equal(called, false);
  const result = await transport(
    new Request("https://wiki.invalid/api/me", {
      headers: { Authorization: "Bearer fake", Cookie: "private" },
    }),
  );
  assert.equal(result.status, 403);
  assert.equal(result.headers.get("set-cookie"), null);
  assert.match(result.headers.get("cache-control"), /no-store/);
});

test("dollar-floor encoded identifier remains a valid fixed-upstream GET", async () => {
  let destination;
  const proxy = createProxy(async (url) => {
    destination = url;
    return new Response("{}");
  });
  const res = response();
  await proxy(
    {
      method: "GET",
      url: "/api/floors/%24/info",
      headers: { authorization: "Bearer fake" },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(destination, "https://cargohustle.online/api/floors/%24/info");
});

test("hosted redirects are rejected without forwarding Location, secrets or following target", async () => {
  let calls = 0;
  const proxy = createProxy(async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: {
        Location: "https://check.ddos-guard.net/check?secret=private",
      },
    });
  });
  const res = response();
  await proxy(
    {
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Bearer fake" },
    },
    res,
  );
  assert.equal(calls, 1);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers.location, undefined);
  assert.equal(res.headers["x-madhouse-redirect-class"], "ddos-protection");
  assert.equal(res.headers["x-madhouse-upstream-status"], "302");
  assert.doesNotMatch(
    JSON.stringify(res.headers) + String(res.body),
    /secret=|check\.ddos/,
  );
});
