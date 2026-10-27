import assert from "node:assert/strict";
import test from "node:test";
import { createRestoreApi } from "./restore-api.js";

const id = "00000000-0000-4000-8000-000000000123";
const challenge = Buffer.alloc(32, 1).toString("base64url");

test("restore review requests a fresh challenge and returns only the bounded status", async () => {
  const calls = [];
  const api = createRestoreApi({
    uuid: () => id,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.operation === "restore.challenge")
        return Response.json({
          operation: body.operation,
          requestId: id,
          challenge,
          expiresAt: 1000,
        });
      return Response.json({
        operation: body.operation,
        requestId: id,
        status: "reconciliation_required",
      });
    },
  });
  assert.equal(await api.review("signed-fixture"), "reconciliation_required");
  assert.deepEqual(
    calls.map((call) => call.operation),
    ["restore.challenge", "restore.review"],
  );
  assert.equal(calls[1].challenge, challenge);
});

test("invalid challenge never sends a review confirmation", async () => {
  let calls = 0;
  const api = createRestoreApi({
    uuid: () => id,
    fetcher: async () => {
      calls++;
      return Response.json({
        operation: "restore.challenge",
        requestId: id,
        challenge: "bad",
        expiresAt: 1000,
      });
    },
  });
  await assert.rejects(
    () => api.review("signed-fixture"),
    /bridge_unavailable/u,
  );
  assert.equal(calls, 1);
});

test("explicit direct restoration returns the confirmed request identity", async () => {
  const calls = [];
  const api = createRestoreApi({
    uuid: () => id,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.operation === "restore.challenge")
        return Response.json({
          operation: body.operation,
          requestId: id,
          challenge,
          expiresAt: 1000,
        });
      return Response.json({
        operation: body.operation,
        requestId: id,
        status: "confirmed",
      });
    },
  });
  assert.equal(await api.beginDirect("signed-fixture"), id);
  assert.equal(calls[1].operation, "restore.confirm");
  assert.equal(calls[1].routePolicy, "direct");
  assert.equal(calls[1].challenge, challenge);
});

test("unknown outcome acknowledgement requires its own challenge", async () => {
  const calls = [];
  const api = createRestoreApi({
    uuid: () => id,
    fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.operation === "restore.challenge")
        return Response.json({
          operation: body.operation,
          requestId: id,
          challenge,
          expiresAt: 1000,
        });
      return Response.json({
        operation: body.operation,
        requestId: id,
        status: "reauthorization_required",
      });
    },
  });
  assert.equal(
    await api.acknowledgeUnknown("signed-fixture"),
    "reauthorization_required",
  );
  assert.equal(calls[1].operation, "restore.ack_unknown");
  assert.equal(calls[1].challenge, challenge);
});

test("restore status rejects extra data and unknown states", async () => {
  const api = createRestoreApi({
    uuid: () => id,
    fetcher: async () =>
      Response.json({
        operation: "restore.status",
        requestId: id,
        status: "ready",
        accessToken: "secret",
      }),
  });
  await assert.rejects(
    () => api.status("signed-fixture"),
    /bridge_unavailable/u,
  );
});
