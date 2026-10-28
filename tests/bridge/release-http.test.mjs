import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeReleaseHttp } from "../../scripts/bridge/release-http.mjs";

test("release endpoint serves only exact public files and rejects symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-public-release-"));
  mkdirSync(join(dir, "releases"));
  writeFileSync(join(dir, "bootstrap.pyz"), "fake-bootstrap");
  writeFileSync(join(dir, "releases", "manifest.json"), "{}");
  writeFileSync(join(dir, "private.pem"), "private-secret");
  symlinkSync(join(dir, "private.pem"), join(dir, "releases", "manifest.sig"));
  const server = createServer(createBridgeReleaseHttp(dir));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await fetch(base + "/bridge/bootstrap.pyz");
    assert.equal(good.status, 200);
    assert.equal(await good.text(), "fake-bootstrap");
    assert.equal(good.headers.get("cache-control"), "no-store");
    assert.equal(
      (await fetch(base + "/bridge/releases/manifest.sig")).status,
      404,
    );
    assert.equal((await fetch(base + "/bridge/private.pem")).status, 404);
    assert.equal((await fetch(base + "/bridge/bootstrap.pyz?x=1")).status, 404);
    assert.equal(
      (await fetch(base + "/bridge/bootstrap.pyz", { method: "POST" })).status,
      404,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
