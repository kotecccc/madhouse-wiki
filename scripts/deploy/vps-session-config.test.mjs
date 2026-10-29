import test from "node:test";
import assert from "node:assert/strict";
import { validateVpsSessionConfig } from "./vps-session-config.mjs";

const valid = {
  ACCOUNT_SESSION_KEY: "a".repeat(64),
  WIKI_SESSION_KEY: "b".repeat(64),
  MADHOUSE_STORAGE_ORIGIN: "https://storage.example.test/private",
  MADHOUSE_STORAGE_TOKEN: "t".repeat(32),
  MADHOUSE_GAME_EXECUTOR_KEY: "c".repeat(64),
  MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://wiki:9095",
  MADHOUSE_SERVICE: "connector",
};

test("VPS requires distinct session keys and private storage configuration", () => {
  assert.doesNotThrow(() => validateVpsSessionConfig(valid));
  for (const name of [
    "ACCOUNT_SESSION_KEY",
    "WIKI_SESSION_KEY",
    "MADHOUSE_STORAGE_ORIGIN",
    "MADHOUSE_STORAGE_TOKEN",
    "MADHOUSE_GAME_EXECUTOR_KEY",
  ]) {
    assert.throws(() => validateVpsSessionConfig({ ...valid, [name]: "" }), {
      message: new RegExp(name),
    });
  }
  assert.throws(
    () =>
      validateVpsSessionConfig({
        ...valid,
        WIKI_SESSION_KEY: valid.ACCOUNT_SESSION_KEY,
      }),
    /must be distinct/,
  );
  assert.throws(
    () =>
      validateVpsSessionConfig({
        ...valid,
        MADHOUSE_STORAGE_ORIGIN: "http://storage.example.test",
      }),
    /MADHOUSE_STORAGE_ORIGIN/,
  );
});

test("VPS requires a separate game executor IPC key and the connector origin", () => {
  assert.doesNotThrow(() => validateVpsSessionConfig(valid));
  assert.throws(
    () =>
      validateVpsSessionConfig({ ...valid, MADHOUSE_GAME_EXECUTOR_KEY: "" }),
    /MADHOUSE_GAME_EXECUTOR_KEY/,
  );
  assert.throws(
    () =>
      validateVpsSessionConfig({
        ...valid,
        MADHOUSE_GAME_EXECUTOR_KEY: "z".repeat(64),
      }),
    /MADHOUSE_GAME_EXECUTOR_KEY/,
  );
  assert.throws(
    () =>
      validateVpsSessionConfig({
        ...valid,
        MADHOUSE_GAME_EXECUTOR_ORIGIN: "http://localhost:9095",
      }),
    /MADHOUSE_GAME_EXECUTOR_ORIGIN/,
  );
  assert.throws(
    () =>
      validateVpsSessionConfig({
        ...valid,
        MADHOUSE_GAME_EXECUTOR_KEY: "a".repeat(64),
      }),
    /must differ from ACCOUNT_SESSION_KEY/,
  );
});
