import { fileURLToPath } from "node:url";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";
import { createReferenceBlobStore } from "../scripts/catalogue/reference-blob-store.mjs";
import { createCatalogueSyncApi } from "../scripts/catalogue/sync-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export function createCatalogueApi({
  root: apiRoot = root,
  storeBlob = createReferenceBlobStore(),
  ...routeOptions
} = {}) {
  return createWikiApiVercelHandler(
    createCatalogueSyncApi({
      root: apiRoot,
      storeBlob,
      ...routeOptions,
    }),
  );
}

export default createCatalogueApi({ allowLegacyDirect: true });
