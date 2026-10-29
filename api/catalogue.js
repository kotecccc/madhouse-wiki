import { fileURLToPath } from "node:url";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";
import { createReferenceBlobStore } from "../scripts/catalogue/reference-blob-store.mjs";
import { createCatalogueSyncApi } from "../scripts/catalogue/sync-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export function createCatalogueHandler({
  fetcher = fetch,
  storeBlob = createReferenceBlobStore(),
  onCatalogue,
} = {}) {
  return createWikiApiVercelHandler(
    createCatalogueSyncApi({ root, storeBlob, fetcher, onCatalogue }),
  );
}
export default createCatalogueHandler();
