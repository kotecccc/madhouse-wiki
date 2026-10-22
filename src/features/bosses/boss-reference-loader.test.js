import test from "node:test";
import assert from "node:assert/strict";
import { createBossReferenceLoader } from "./boss-reference-loader.js";

test("a persisted boss never triggers another game import, including all-null rewards", async () => {
  let imports = 0,
    reads = 0;
  const boss = {
    apiId: "49",
    rewardPreview: { gold: null, pills: null, dollar: null },
    rewardPreviewCaptured: true,
  };
  const loader = createBossReferenceLoader({
    readSaved: async () => {
      reads++;
      return { boss };
    },
    importReference: async () => {
      imports++;
    },
  });
  await loader.ensure("49", true);
  await loader.ensure("49", true);
  assert.equal(reads, 1);
  assert.equal(imports, 0);
  assert.deepEqual(loader.snapshot("49").boss, boss);
});

test("parallel cards and an anonymous-to-ready transition share a single import", async () => {
  let reads = 0,
    imports = 0;
  const published = [];
  const loader = createBossReferenceLoader({
    readSaved: async () => {
      reads++;
      await Promise.resolve();
      return { boss: { apiId: "49", rewardPreviewCaptured: false } };
    },
    importReference: async () => {
      imports++;
      return {
        boss: {
          apiId: "49",
          rewardPreview: { gold: 125 },
          rewardPreviewCaptured: true,
        },
      };
    },
    onReference: (boss) => published.push(boss),
  });
  await Promise.all([
    loader.ensure("49", false),
    loader.ensure("49", true),
    loader.ensure("49", true),
  ]);
  assert.equal(reads, 1);
  assert.equal(imports, 1);
  assert.equal(loader.snapshot("49").status, "ready");
  assert.equal(published.at(-1).rewardPreview.gold, 125);
});

test("anonymous reads do not import and a later authorized opening fills the cache once", async () => {
  let imports = 0;
  const loader = createBossReferenceLoader({
    readSaved: async () => ({
      boss: { apiId: "49", rewardPreviewCaptured: false },
    }),
    importReference: async () => {
      imports++;
      return { boss: { apiId: "49", rewardPreviewCaptured: true } };
    },
  });
  await loader.ensure("49", false);
  assert.equal(imports, 0);
  await loader.ensure("49", true);
  await loader.ensure("49", true);
  assert.equal(imports, 1);
});

test("failed imports do not produce a request loop or a false saved flag", async () => {
  let imports = 0;
  const loader = createBossReferenceLoader({
    readSaved: async () => ({
      boss: { apiId: "49", rewardPreviewCaptured: false },
    }),
    importReference: async () => {
      imports++;
      throw new Error("429");
    },
  });
  await loader.ensure("49", true);
  await loader.ensure("49", true);
  assert.equal(imports, 1);
  assert.equal(loader.snapshot("49").status, "error");
  assert.equal(loader.snapshot("49").boss.rewardPreviewCaptured, false);
});
