import { cachedInlineCards } from "./inline-card-cache.mjs";

async function loadRenderer(root) {
  const [{ readKnowledgeBase }, { generateInlineCards }] = await Promise.all([
    import("../catalogue/query.mjs"),
    import("./inline-card-renderer.mjs"),
  ]);
  return {
    knowledgeBase: readKnowledgeBase(root),
    generate: generateInlineCards,
  };
}

// No renderer imports, browser startup or image requests in local/CI builds.
export async function loadVpsInlineCards({
  root,
  env = process.env,
  load = loadRenderer,
  cacheOptions = {},
}) {
  if (
    env.NODE_ENV !== "production" ||
    env.MADHOUSE_SERVICE !== "wiki" ||
    env.MADHOUSE_VPS_INLINE_CARDS !== "1"
  )
    return new Map();
  if (!env.MADHOUSE_INLINE_CARDS_CACHE_DIR)
    throw new Error("VPS Telegram cards require a persistent cache directory");
  const { knowledgeBase, generate } = await load(root);
  const cards = await cachedInlineCards(knowledgeBase, root, generate, {
    ...cacheOptions,
    cacheDir: env.MADHOUSE_INLINE_CARDS_CACHE_DIR,
    force: env.MADHOUSE_INLINE_CARDS_REFRESH === "1",
    log: console.info,
  });
  return new Map(
    cards.map(({ filename, buffer }) => [`/inline-cards/${filename}`, buffer]),
  );
}
