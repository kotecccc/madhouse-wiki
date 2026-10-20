import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionFailure,
  diagnosticSuffix,
} from "../connector/diagnostics.js";
import { createConnection } from "../connector/session.js";

test("diagnostics retain only bounded stage/category and discard private error data", () => {
  const privateText = "private-phone-session-url";
  for (const [name, category] of [
    ["SecurityError", "SECURITY"],
    ["CompileError", "WASM_COMPILE"],
    ["TypeError", "TYPE"],
    [privateText, "UNKNOWN"],
  ]) {
    const failure = connectionFailure(
      { name, message: privateText, text: privateText, request: privateText },
      "RESTORE",
    );
    assert.equal(failure.diagnosticCode, `TG_RESTORE_${category}`);
    assert.equal(failure.message, "telegram_unavailable");
    assert.equal(failure.cause, undefined);
    assert.deepEqual(Object.keys(failure), ["diagnosticCode"]);
    assert.ok(!JSON.stringify(failure).includes(privateText));
    assert.ok(!failure.stack.includes(privateText));
  }
  assert.equal(diagnosticSuffix({ diagnosticCode: privateText }), "");
  assert.equal(
    connectionFailure({}, privateText).diagnosticCode,
    "TG_BOOT_UNKNOWN",
  );
});

test("known RPC limits are classified without retaining arbitrary text or wait duration", () => {
  for (const text of [
    "API_ID_INVALID",
    "API_ID_PUBLISHED_FLOOD",
    "AUTH_KEY_DUPLICATED",
  ])
    assert.equal(
      connectionFailure({ text }, "RESTORE").diagnosticCode,
      `TG_RESTORE_${text}`,
    );
  assert.equal(
    connectionFailure({ text: "FLOOD_WAIT_98765" }, "RESTORE").diagnosticCode,
    "TG_RESTORE_FLOOD_WAIT",
  );
  assert.equal(
    connectionFailure({ text: "FLOOD_WAIT_98765_private" }, "RESTORE")
      .diagnosticCode,
    "TG_RESTORE_UNKNOWN",
  );
});

test("typed library errors are recognized even when names are Error or minified", () => {
  class a extends Error {}
  const failure = connectionFailure(new a("private"), "RESTORE", {
    MtTimeoutError: a,
  });
  assert.equal(failure.diagnosticCode, "TG_RESTORE_MT_TIMEOUT");
  assert.equal(diagnosticSuffix(failure), " (TG_RESTORE_MT_TIMEOUT)");
});

test("client initialization and getMe failures preserve distinct safe phases", async () => {
  const startup = createConnection({
    createClient: () => {
      throw new DOMException("private", "SecurityError");
    },
  });
  await assert.rejects(startup.restore(), {
    message: "telegram_unavailable",
    diagnosticCode: "TG_CLIENT_SECURITY",
  });
  const restore = createConnection({
    createClient: () => ({
      getMe: async () => {
        throw new TypeError("private");
      },
    }),
  });
  await assert.rejects(restore.restore(), {
    message: "telegram_unavailable",
    diagnosticCode: "TG_RESTORE_TYPE",
  });
  const unauthenticated = createConnection({
    createClient: () => ({
      getMe: async () => {
        throw { text: "AUTH_KEY_UNREGISTERED" };
      },
    }),
  });
  assert.equal(await unauthenticated.restore(), false);
});
