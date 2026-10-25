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

// Readiness of optional Telegram assets must not block the Wiki HTTP server.
export function startVpsInlineCards({
  loadCards = loadVpsInlineCards,
  onError = () =>
    console.error(
      "Telegram cards: generation failed; cards unavailable until the next service restart",
    ),
  ...options
}) {
  let cards = new Map();
  let status = "loading";
  const ready = Promise.resolve()
    .then(() => loadCards(options))
    .then((loaded) => {
      cards = loaded;
      status = "ready";
    })
    .catch((error) => {
      status = "failed";
      onError(error);
    });
  return {
    get status() {
      return status;
    },
    get: (path) => cards.get(path),
    ready,
  };
}
