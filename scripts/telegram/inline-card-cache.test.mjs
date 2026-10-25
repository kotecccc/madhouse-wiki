import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cachedInlineCards, inlineCardCacheKey } from "./inline-card-cache.mjs";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "inline-card-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    resolve(root, "entry.jsx"),
    'import "./card.css"; export { card } from "./card.js";',
  );
  await writeFile(resolve(root, "card.css"), "color: var(--text);");
  await writeFile(resolve(root, "card.js"), "export const card = 1;");
  return { root, inputs: ["entry.jsx"] };
}

test("cache reuses exact bytes across calls and invalidates catalogue and transitive inputs", async (t) => {
  const { root, inputs } = await fixture(t);
  let calls = 0;
  const generate = async () => [
    { filename: "floor.jpg", buffer: Buffer.from(`card-${++calls}`) },
  ];
  const options = { inputs, now: 1000 };
  const first = await cachedInlineCards(
    { title: "A" },
    root,
    generate,
    options,
  );
  assert.deepEqual(
    await cachedInlineCards({ title: "A" }, root, generate, options),
    first,
  );
  assert.equal(calls, 1);
  await writeFile(resolve(root, "unrelated.jsx"), "unrelated page");
  await cachedInlineCards({ title: "A" }, root, generate, options);
  assert.equal(calls, 1);
  await writeFile(resolve(root, "card.css"), "color: var(--other);");
  await cachedInlineCards({ title: "A" }, root, generate, options);
  assert.equal(calls, 2);
  await cachedInlineCards({ title: "B" }, root, generate, options);
  assert.equal(calls, 3);
  await writeFile(resolve(root, "card.js"), "export const card = 2;");
  await cachedInlineCards({ title: "B" }, root, generate, options);
  assert.equal(calls, 4);
});

test("expired, forced and corrupt caches regenerate; failed generation is not saved", async (t) => {
  const { root, inputs } = await fixture(t);
  let calls = 0;
  const generate = async () => [
    { filename: "floor.jpg", buffer: Buffer.from(`card-${++calls}`) },
  ];
  const options = { inputs, now: 1000 };
  await cachedInlineCards({}, root, generate, options);
  await cachedInlineCards({}, root, generate, {
    ...options,
    now: 1000 + 24 * 60 * 60 * 1000,
  });
  assert.equal(calls, 2);
  await cachedInlineCards({}, root, generate, { ...options, force: true });
  assert.equal(calls, 3);
  const path = resolve(
    root,
    "node_modules/.cache/madhouse-inline-cards/cards.json",
  );
  const saved = JSON.parse(await readFile(path, "utf8"));
  saved.cards[0].data = Buffer.from("damaged").toString("base64");
  await writeFile(path, JSON.stringify(saved));
  await cachedInlineCards({}, root, generate, options);
  assert.equal(calls, 4);
  await assert.rejects(
    cachedInlineCards(
      { changed: true },
      root,
      async () => {
        throw new Error("renderer failed");
      },
      options,
    ),
    /renderer failed/,
  );
  await cachedInlineCards({}, root, generate, options);
  assert.equal(calls, 4);
});

test("cache tracks HTML, dynamic imports and CSS asset dependencies", async (t) => {
  const { root } = await fixture(t);
  await mkdir(resolve(root, "public"));
  await writeFile(
    resolve(root, "preview.html"),
    '<script src="./entry.jsx"></script>',
  );
  await writeFile(
    resolve(root, "entry.jsx"),
    'import("./card.js"); import "./card.css";',
  );
  await writeFile(resolve(root, "card.css"), 'background: url("/image.png");');
  await writeFile(resolve(root, "public/image.png"), "image-a");
  const before = await inlineCardCacheKey({}, root, ["preview.html"]);
  await writeFile(resolve(root, "public/image.png"), "image-b");
  assert.notEqual(await inlineCardCacheKey({}, root, ["preview.html"]), before);
});
