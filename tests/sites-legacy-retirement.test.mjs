import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

test("generated Sites worker retires game API and still serves static assets", async () => {
  const directory = mkdtempSync(join(tmpdir(), "sites-retirement-"));
  try {
    mkdirSync(join(directory, "dist"));
    mkdirSync(join(directory, ".openai"));
    writeFileSync(join(directory, "dist", "index.html"), "<h1>Wiki</h1>");
    writeFileSync(join(directory, "dist", "connection-config.json"), "{}");
    writeFileSync(join(directory, ".openai", "hosting.json"), "{}");
    const build = fileURLToPath(
      new URL("../scripts/deploy/build-sites.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [build], {
      cwd: directory,
      env: {
        ...process.env,
        MADHOUSE_RELEASE_SHA: "a".repeat(40),
        MADHOUSE_REQUIRE_TELEGRAM_CONNECTOR: "0",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(
      join(directory, "dist", "server", "index.js"),
      "utf8",
    );
    assert.doesNotMatch(output, /cargohustle\.online|createProductionApi/);
    const modulePath = join(directory, "worker.mjs");
    writeFileSync(modulePath, output);
    const worker = (await import(pathToFileURL(modulePath).href)).default;
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await worker.fetch(
        new Request("https://example.test/api/me", {
          method,
          headers: { authorization: "Bearer fake" },
        }),
      );
      assert.equal(response.status, 410);
      assert.deepEqual(await response.json(), {
        error: "legacy_game_api_retired",
      });
      assert.match(response.headers.get("cache-control"), /no-store/);
    }
    const page = await worker.fetch(new Request("https://example.test/"));
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<h1>Wiki</h1>");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
