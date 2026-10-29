import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import {
  createDirectGameIpcClient,
  createDirectGameIpcServer,
} from "./direct-ipc.mjs";

const secret = "direct-game-ipc-test-secret-32-bytes-long";
const endpoint = "http://wiki:9095/internal/game/direct";

async function withServer(execute, run) {
  const server = createDirectGameIpcServer({ execute, secret });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const localEndpoint = `http://127.0.0.1:${address.port}/internal/game/direct`;
  try {
    await run(localEndpoint, server);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function clientFor(localEndpoint) {
  return createDirectGameIpcClient({
    endpoint,
    secret,
    fetcher: (url, init) => fetch(new URL(url.pathname, localEndpoint), init),
  });
}

test("confirmed refusal before dispatch survives the internal hop", async () => {
  await withServer(
    async () => {
      throw Object.assign(new Error("cancelled"), { notDispatched: true });
    },
    async (localEndpoint) => {
      await assert.rejects(
        clientFor(localEndpoint)("https://cargohustle.online/api/me"),
        (failure) => failure.notDispatched === true,
      );
    },
  );
});

test("direct IPC client transfers an approved request and faithfully relays bytes/status headers", async () => {
  const calls = [];
  await withServer(
    async (url, init) => {
      calls.push({ url, init });
      return new Response(Buffer.from([0, 7, 255, 13]), {
        status: 429,
        headers: {
          "Content-Type": "application/octet-stream",
          "Retry-After": "17",
          Date: "Tue, 01 Jan 2030 00:00:00 GMT",
          Server: "game-edge",
        },
      });
    },
    async (localEndpoint) => {
      const directFetch = clientFor(localEndpoint);
      const response = await directFetch(
        "https://cargohustle.online/api/auth/telegram",
        {
          method: "POST",
          redirect: "error",
          gameAttempt: 2,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test",
          },
          body: Buffer.from([1, 2, 0, 255]),
        },
      );
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "17");
      assert.equal(
        response.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from([0, 7, 255, 13]),
      );
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cargohustle.online/api/auth/telegram");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.gameAttempt, 2);
  assert.equal(
    calls[0].init.headers.find(([name]) => name === "authorization")[1],
    "Bearer test",
  );
  assert.deepEqual(calls[0].init.body, Buffer.from([1, 2, 0, 255]));
});

test("direct IPC accepts only the two approved game route/method pairs", async () => {
  let executions = 0;
  await withServer(
    async () => {
      executions += 1;
      return new Response("ok");
    },
    async (localEndpoint) => {
      const directFetch = clientFor(localEndpoint);
      for (const [url, init] of [
        ["https://cargohustle.online/api/me?x=1", { method: "GET" }],
        ["https://cargohustle.online/api/players/3", { method: "GET" }],
        ["https://cargohustle.online/api/me", { method: "POST" }],
        ["https://evil.example/api/me", { method: "GET" }],
        [
          "https://cargohustle.online/api/me",
          { method: "GET", redirect: "follow" },
        ],
      ]) {
        await assert.rejects(directFetch(url, init), {
          dispatched: "notDispatched",
        });
      }
    },
  );
  assert.equal(executions, 0);
});

test("invalid authentication never invokes the injected executor", async () => {
  let executions = 0;
  await withServer(
    async () => {
      executions += 1;
      return new Response("unexpected");
    },
    async (localEndpoint) => {
      const response = await fetch(localEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Direct-Ipc-Nonce": "0".repeat(32),
          "X-Direct-Ipc-Signature": "0".repeat(64),
        },
        body: "{}",
      });
      assert.equal(response.status, 401);
    },
  );
  assert.equal(executions, 0);
});

test("transport failures after dispatch report an unknown result and never retry", async () => {
  let dispatches = 0;
  const directFetch = createDirectGameIpcClient({
    endpoint,
    secret,
    fetcher: async () => {
      dispatches += 1;
      throw new Error("socket reset");
    },
  });
  await assert.rejects(
    directFetch("https://cargohustle.online/api/me", { method: "GET" }),
    (caught) =>
      caught.code === "game_result_unknown" && caught.dispatched === "unknown",
  );
  assert.equal(dispatches, 1);
});

test("client cancellation reaches the executor and remains outcome-unknown", async () => {
  let executorSignal;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  await withServer(
    (_url, init) => {
      executorSignal = init.signal;
      init.signal.addEventListener("abort", entered, { once: true });
      entered();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new Error("cancelled")),
          { once: true },
        );
      });
    },
    async (localEndpoint) => {
      const directFetch = clientFor(localEndpoint);
      const controller = new AbortController();
      const request = directFetch("https://cargohustle.online/api/me", {
        method: "GET",
        signal: controller.signal,
      });
      await started;
      controller.abort();
      await assert.rejects(
        request,
        (caught) => caught.dispatched === "unknown",
      );
      await Promise.race([
        new Promise((resolve) =>
          executorSignal.addEventListener("abort", resolve, { once: true }),
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("executor_not_cancelled")), 1000),
        ),
      ]);
      assert.equal(executorSignal.aborted, true);
    },
  );
});

test("signed timestamp window expires and authenticated nonce replay is rejected", async () => {
  let executions = 0;
  await withServer(
    async () => {
      executions += 1;
      return new Response("ok");
    },
    async (localEndpoint) => {
      const stamp = String(Date.now());
      const nonce = "a".repeat(32);
      const payload = Buffer.from(
        JSON.stringify({
          url: "https://cargohustle.online/api/me",
          method: "GET",
          headers: [],
          redirect: "manual",
          binding: null,
          attempt: 1,
          body: null,
        }),
      );
      const sign = (timestamp) =>
        createHmac("sha256", secret)
          .update("madhouse-direct-game-ipc-v1\n")
          .update(timestamp)
          .update("\n")
          .update(nonce)
          .update("\n")
          .update(payload)
          .digest("hex");
      const send = (timestamp, signature) =>
        fetch(localEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Direct-Ipc-Time": timestamp,
            "X-Direct-Ipc-Nonce": nonce,
            "X-Direct-Ipc-Signature": signature,
          },
          body: payload,
        });
      const first = await send(stamp, sign(stamp));
      assert.equal(first.status, 200);
      const replay = await send(stamp, sign(stamp));
      assert.equal(replay.status, 409);
      const staleStamp = String(Date.now() - 61_000);
      const stale = await send(staleStamp, sign(staleStamp));
      assert.equal(stale.status, 401);
    },
  );
  assert.equal(executions, 1);
});
