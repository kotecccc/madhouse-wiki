import test from "node:test";
import assert from "node:assert/strict";
import { authSessionPlugin } from "../scripts/auth-session-plugin.mjs";

test("auth module and all relative imports are emitted and served as JavaScript", () => {
  const plugin = authSessionPlugin();
  plugin.configResolved({ env: {} });
  const emitted = new Map();
  plugin.generateBundle.call({
    emitFile(asset) {
      emitted.set(asset.fileName, asset.source);
    },
  });
  const pending = ["auth-session.js"];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const contents = emitted.get(name);
    assert.equal(typeof contents, "string", `${name} is missing from build`);
    for (const match of contents.matchAll(
      /(?:from\s*|import\s*)["']\.\/([^"']+)["']/g,
    ))
      pending.push(match[1]);
  }
  let middleware;
  plugin.configureServer({
    middlewares: {
      use: (fn) => {
        middleware = fn;
      },
    },
  });
  for (const name of visited) {
    const headers = {};
    let body;
    middleware(
      { url: `/${name}` },
      {
        setHeader: (key, value) => {
          headers[key] = value;
        },
        end: (value) => {
          body = value;
        },
      },
      () => assert.fail(`${name} was not served`),
    );
    assert.equal(headers["Content-Type"], "application/javascript");
    assert.equal(body, emitted.get(name));
  }
});
