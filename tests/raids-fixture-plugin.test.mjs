import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { raidsFixturePlugin } from "../scripts/raids-fixture-plugin.mjs";

test("local fixture is available without a special launch command", (t) => {
  const root = mkdtempSync(join(tmpdir(), "raids-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "artifacts/development"), { recursive: true });
  const data = {
    posts: [{ sourceMessageId: 1, raids: [{ boss: "Example" }] }],
  };
  writeFileSync(
    join(root, "artifacts/development/raids-production.json"),
    JSON.stringify(data),
  );
  const previous = process.env.MADHOUSE_RAIDS_FIXTURE;
  delete process.env.MADHOUSE_RAIDS_FIXTURE;
  t.after(() => {
    if (previous === undefined) delete process.env.MADHOUSE_RAIDS_FIXTURE;
    else process.env.MADHOUSE_RAIDS_FIXTURE = previous;
  });
  let handler;
  const server = {
    middlewares: {
      use(value) {
        handler = value;
      },
    },
  };
  raidsFixturePlugin(root).configureServer(server);
  let body;
  handler(
    { url: "/api/raids" },
    {
      writeHead(code) {
        assert.equal(code, 200);
      },
      end(value) {
        body = JSON.parse(value);
      },
    },
    () => assert.fail("fixture should serve raids"),
  );
  assert.deepEqual(body, data);
  let forwarded = false;
  handler({ url: "/api/other" }, {}, () => {
    forwarded = true;
  });
  assert.equal(forwarded, true);
  process.env.MADHOUSE_RAIDS_FIXTURE = "0";
  handler = undefined;
  raidsFixturePlugin(root).configureServer(server);
  assert.equal(handler, undefined);
});

test("a checkout without local fixture keeps the API proxy", () => {
  let installed = false;
  const previous = process.env.MADHOUSE_RAIDS_FIXTURE;
  delete process.env.MADHOUSE_RAIDS_FIXTURE;
  try {
    raidsFixturePlugin(
      join(tmpdir(), "no-madhouse-fixture-here"),
    ).configureServer({
      middlewares: {
        use() {
          installed = true;
        },
      },
    });
    assert.equal(installed, false);
  } finally {
    if (previous === undefined) delete process.env.MADHOUSE_RAIDS_FIXTURE;
    else process.env.MADHOUSE_RAIDS_FIXTURE = previous;
  }
});
