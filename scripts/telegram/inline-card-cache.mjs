import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, relative } from "node:path";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const entries = [
  "scripts/telegram/inline-card-renderer.mjs",
  "scripts/telegram/inline-boss-card-preview.html",
  "scripts/telegram/inline-business-card-preview.html",
  "src/styles/tokens.css",
  "package-lock.json",
];
const digest = (value) => createHash("sha256").update(value).digest("hex");

// Follow local imports, re-exports, HTML references and CSS assets. Unrelated
// pages do not invalidate the cards; their shared rendering dependencies do.
export async function inlineCardCacheKey(
  knowledgeBase,
  root,
  inputs = entries,
) {
  const files = new Map();
  async function visit(path) {
    path = resolve(root, path);
    if (files.has(path)) return;
    const bytes = await readFile(path);
    files.set(path, bytes);
    if (!/\.(?:[cm]?js|jsx|css|html)$/u.test(extname(path))) return;
    const source = bytes.toString("utf8");
    const references = [
      ...source.matchAll(
        /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu,
      ),
      ...source.matchAll(/(?:src|href)=["']([^"']+)["']/gu),
      ...source.matchAll(/(?:url\(\s*|@import\s*)["']?([^\s"')]+)["']?/gu),
    ];
    for (const [, reference] of references) {
      if (reference.startsWith(".")) {
        await visit(resolve(dirname(path), reference.split(/[?#]/u)[0]));
      } else if (reference.startsWith("/") && !reference.startsWith("//")) {
        await visit(
          resolve(root, "public", reference.slice(1).split(/[?#]/u)[0]),
        );
      }
    }
  }
  for (const entry of inputs) await visit(entry);
  const hash = createHash("sha256").update(
    JSON.stringify({
      version: 1,
      knowledgeBase,
      runtime: [process.version, process.platform, process.arch],
      browser: process.env.PUPPETEER_EXECUTABLE_PATH || "bundled",
    }),
  );
  for (const [path, bytes] of [...files].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    hash.update(JSON.stringify([relative(root, path), digest(bytes)]));
  }
  return hash.digest("hex");
}

export async function cachedInlineCards(
  knowledgeBase,
  root,
  generate,
  options = {},
) {
  const key = await inlineCardCacheKey(knowledgeBase, root, options.inputs);
  const path = resolve(
    options.cacheDir ||
      resolve(root, "node_modules/.cache/madhouse-inline-cards"),
    "cards.json",
  );
  const now = options.now ?? Date.now();
  if (!options.force && process.env.MADHOUSE_INLINE_CARDS_REFRESH !== "1") {
    try {
      const saved = JSON.parse(await readFile(path, "utf8"));
      if (
        saved.key === key &&
        now >= saved.createdAt &&
        now - saved.createdAt < MAX_AGE_MS &&
        Array.isArray(saved.cards)
      ) {
        const cards = saved.cards.map(({ filename, data, sha256 }) => {
          const buffer = Buffer.from(data, "base64");
          if (!filename || !buffer.length || digest(buffer) !== sha256)
            throw new Error("Invalid cached card");
          return { filename, buffer };
        });
        options.log?.("Telegram cards: cache hit");
        return cards;
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        options.log?.("Telegram cards: unreadable cache; regenerating");
    }
  }
  options.log?.("Telegram cards: cache miss; generating");
  const cards = await generate(knowledgeBase, root);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({
        key,
        createdAt: now,
        cards: cards.map(({ filename, buffer }) => ({
          filename,
          data: buffer.toString("base64"),
          sha256: digest(buffer),
        })),
      }),
    );
    await rename(temporary, path);
  } catch (error) {
    options.log?.(
      `Telegram cards: could not save cache (${error.code || error.name})`,
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return cards;
}
