import test from "node:test";
import assert from "node:assert/strict";
import { createProxy } from "../api/[...path].js";
function response() {
  return {
    headers: {},
    setHeader(key, value) {
      this.headers[key] = value;
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
    assert.match(res.headers["Cache-Control"], /no-store/);
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
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.cache, "no-store");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["set-cookie"], undefined);
  assert.match(res.headers["Vercel-CDN-Cache-Control"], /no-store/);
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
    if (status === 429) assert.equal(res.headers["Retry-After"], "15");
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
  assert.doesNotMatch(res.body, /secret/);
});
