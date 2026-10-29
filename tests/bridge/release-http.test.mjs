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
import { createHash } from "node:crypto";
import {
  createBridgeReleaseHttp,
  verifyBridgeRelease,
} from "../../scripts/bridge/release-http.mjs";

test("startup rejects missing, altered, and symlinked release files", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-release-check-"));
  const digest = createHash("sha256").update("bootstrap").digest("hex");
  try {
    mkdirSync(join(dir, "releases"));
    writeFileSync(join(dir, "bootstrap.pyz"), "bootstrap");
    for (const name of ["madhouse-bridge.pyz", "manifest.json", "manifest.sig"])
      writeFileSync(join(dir, "releases", name), "valid-size");
    assert.doesNotThrow(() => verifyBridgeRelease(dir, digest));
    assert.throws(() => verifyBridgeRelease(dir, "0".repeat(64)), {
      message: "bridge_release_invalid",
    });
    rmSync(join(dir, "releases", "manifest.sig"));
    assert.throws(() => verifyBridgeRelease(dir, digest), {
      message: "bridge_release_invalid",
    });
    symlinkSync(
      join(dir, "bootstrap.pyz"),
      join(dir, "releases", "manifest.sig"),
    );
    assert.throws(() => verifyBridgeRelease(dir, digest), {
      message: "bridge_release_invalid",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release endpoint serves only exact public files and rejects symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-public-release-"));
  mkdirSync(join(dir, "releases"));
  writeFileSync(join(dir, "bootstrap.pyz"), "fake-bootstrap");
  writeFileSync(join(dir, "MadhouseWikiBridge-macOS.zip"), "fake-zip");
  writeFileSync(join(dir, "MadhouseWikiBridge-Windows.zip"), "fake-windows");
  mkdirSync(join(dir, "windows-releases"));
  writeFileSync(
    join(dir, "windows-releases", "manifest.json"),
    "windows-manifest",
  );
  writeFileSync(join(dir, "releases", "manifest.json"), "{}");
  writeFileSync(join(dir, "private.pem"), "private-secret");
  symlinkSync(join(dir, "private.pem"), join(dir, "releases", "manifest.sig"));
  const windowsSha256 = createHash("sha256")
    .update("fake-windows")
    .digest("hex");
  const server = createServer(createBridgeReleaseHttp(dir, { windowsSha256 }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await fetch(base + "/bridge/bootstrap.pyz");
    assert.equal(good.status, 200);
    assert.equal(await good.text(), "fake-bootstrap");
    assert.equal(good.headers.get("cache-control"), "no-store");
    const mac = await fetch(base + "/bridge/MadhouseWikiBridge-macOS.zip");
    assert.equal(await mac.text(), "fake-zip");
    assert.match(mac.headers.get("content-disposition"), /attachment/);
    const windows = await fetch(
      base + "/bridge/MadhouseWikiBridge-Windows.zip",
    );
    assert.equal(await windows.text(), "fake-windows");
    assert.match(windows.headers.get("content-disposition"), /Windows/);
    assert.equal(
      await (
        await fetch(base + "/bridge/windows-releases/manifest.json")
      ).text(),
      "windows-manifest",
    );
    writeFileSync(join(dir, "MadhouseWikiBridge-Windows.zip"), "tampered");
    assert.equal(
      (await fetch(base + "/bridge/MadhouseWikiBridge-Windows.zip")).status,
      404,
    );
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
