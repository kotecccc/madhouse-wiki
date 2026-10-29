import test from "node:test";
import assert from "node:assert/strict";
import { validateVpsSessionConfig } from "./vps-session-config.mjs";

const valid = {
  ACCOUNT_SESSION_KEY: "a".repeat(64),
  WIKI_SESSION_KEY: "b".repeat(64),
  MADHOUSE_STORAGE_ORIGIN: "https://storage.example.test/private",
  MADHOUSE_STORAGE_TOKEN: "t".repeat(32),
};

test("VPS requires distinct session keys and private storage configuration", () => {
  assert.doesNotThrow(() => validateVpsSessionConfig(valid));
  for (const name of Object.keys(valid)) {
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
