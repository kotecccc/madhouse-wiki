import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadVpsInlineCards } from "./inline-cards-vps.mjs";

test("local, CI and connector configurations never load the generator", async () => {
  for (const env of [
    {},
    { NODE_ENV: "production" },
    {
      NODE_ENV: "development",
      MADHOUSE_SERVICE: "wiki",
      MADHOUSE_VPS_INLINE_CARDS: "1",
    },
    {
      NODE_ENV: "production",
      MADHOUSE_SERVICE: "connector",
      MADHOUSE_VPS_INLINE_CARDS: "1",
    },
    { NODE_ENV: "production", MADHOUSE_SERVICE: "wiki" },
  ]) {
    const cards = await loadVpsInlineCards({
      root: "/unused",
      env,
      load: () => {
        throw new Error("must not load renderer");
      },
    });
    assert.equal(cards.size, 0);
  }
});

test("VPS startup uses its persistent cache and exposes card bytes", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "vps-inline-cards-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "template.js"), "template");
  const cacheDir = resolve(root, "persistent-volume");
  const env = {
    NODE_ENV: "production",
    MADHOUSE_SERVICE: "wiki",
    MADHOUSE_VPS_INLINE_CARDS: "1",
    MADHOUSE_INLINE_CARDS_CACHE_DIR: cacheDir,
  };
  let calls = 0;
  const load = async () => ({
    knowledgeBase: {},
    generate: async () => {
      calls++;
      return [{ filename: "floor.jpg", buffer: Buffer.from("image") }];
    },
  });
  const options = {
    root,
    env,
    load,
    cacheOptions: { inputs: ["template.js"] },
  };
  const first = await loadVpsInlineCards(options);
  assert.deepEqual(first.get("/inline-cards/floor.jpg"), Buffer.from("image"));
  await access(resolve(cacheDir, "cards.json"));
  assert.deepEqual(await loadVpsInlineCards(options), first);
  assert.equal(calls, 1);
  await loadVpsInlineCards({
    ...options,
    env: { ...env, MADHOUSE_INLINE_CARDS_REFRESH: "1" },
  });
  assert.equal(calls, 2);
  await assert.rejects(
    loadVpsInlineCards({
      ...options,
      env: { ...env, MADHOUSE_INLINE_CARDS_CACHE_DIR: "" },
    }),
    /persistent cache/,
  );
});
