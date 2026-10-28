import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { recoverEsbuildPlugin } from "../scripts/dev/vite-server.mjs";

test("Vite recovers a killed esbuild child without restarting the server", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vite-recovery-")));
  await writeFile(
    join(root, "entry.jsx"),
    "export const view = <div>ok</div>;",
  );
  const server = await createServer({
    root,
    configFile: false,
    plugins: [recoverEsbuildPlugin()],
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "silent",
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    const url = `http://127.0.0.1:${address.port}/entry.jsx?import`;
    const first = await fetch(url, { headers: { Accept: "text/javascript" } });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /createElement/);
    const lines = execFileSync("ps", ["-axo", "pid,ppid,command"], {
      encoding: "utf8",
    }).split("\n");
    const child = lines
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .find(
        (line) =>
          line &&
          Number(line[2]) === process.pid &&
          /esbuild.*--service=/.test(line[3]),
      );
    assert.ok(child, "esbuild child is running");
    process.kill(Number(child[1]), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(
      join(root, "entry.jsx"),
      "export const view = <div>changed</div>;",
    );
    const failed = await fetch(`${url}&after-kill`, {
      headers: { Accept: "text/javascript" },
    });
    assert.equal(failed.status, 500);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const recovered = await fetch(`${url}&after-recovery`, {
      headers: { Accept: "text/javascript" },
    });
    assert.equal(recovered.status, 200);
    assert.match(await recovered.text(), /changed/);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary compilation errors do not reset esbuild or reload the page", async () => {
  let resets = 0;
  let reloads = 0;
  const server = {
    config: { logger: { error() {} } },
    ws: {
      send() {
        reloads++;
      },
    },
  };
  recoverEsbuildPlugin({
    stop: () => {
      resets++;
    },
    schedule: (callback) => callback(),
  }).configureServer(server);
  server.config.logger.error("syntax error", {
    error: { plugin: "vite:esbuild", message: "Unexpected token" },
  });
  await Promise.resolve();
  assert.equal(resets, 0);
  assert.equal(reloads, 0);
});
