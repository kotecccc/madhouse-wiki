import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createBridgeNodeAdapter } from "../../scripts/bridge/node-adapter.mjs";

async function setup(runtime) {
  const adapter = createBridgeNodeAdapter({
    runtime,
    origin: "https://wiki.example",
  });
  const server = createServer(adapter.handle);
  server.on("upgrade", adapter.upgrade);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("node adapter forwards only allowed routes and derives peer from socket", async () => {
  let seen;
  const host = await setup({
    async handle(request, peer) {
      seen = {
        peer,
        origin: request.headers.get("origin"),
        forged: request.headers.get("x-forwarded-for"),
        body: await request.json(),
      };
      return Response.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    },
    upgrade() {},
  });
  try {
    const response = await fetch(host.base + "/api/bridge/device", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://wiki.example",
        "X-Forwarded-For": "8.8.8.8",
      },
      body: JSON.stringify({ operation: "status" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, {
      peer: "127.0.0.1",
      origin: "https://wiki.example",
      forged: null,
      body: { operation: "status" },
    });
    assert.equal(
      (await fetch(host.base + "/api/bridge/device?x=1", { method: "POST" }))
        .status,
      404,
    );
    assert.equal(
      (
        await fetch(host.base + "/api/bridge/device", {
          method: "POST",
          body: "x".repeat(8193),
        })
      ).status,
      413,
    );
  } finally {
    await new Promise((resolve) => host.server.close(resolve));
  }
});

test("node adapter preserves actual runtime authentication and never exposes secrets in errors", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createBridgeRuntime } =
    await import("../../scripts/bridge/runtime.mjs");
  const dir = mkdtempSync(join(tmpdir(), "bridge-http-adapter-"));
  const runtime = createBridgeRuntime({
    directory: dir,
    origin: "https://wiki.example",
    botToken: "fake-bot",
    consume: () => true,
  });
  const host = await setup(runtime);
  try {
    const response = await fetch(host.base + "/api/bridge/device", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://wiki.example",
      },
      body: JSON.stringify({ operation: "status", initData: "fake-secret" }),
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "not_authorized" });
  } finally {
    await new Promise((resolve) => host.server.close(resolve));
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
