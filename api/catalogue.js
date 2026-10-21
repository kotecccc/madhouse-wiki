import { fileURLToPath } from "node:url";
import { createWikiApiVercelHandler } from "../scripts/telegram/wiki-api-vercel-handler.mjs";
import { createReferenceBlobStore } from "../scripts/catalogue/reference-blob-store.mjs";
import { createCatalogueSyncApi } from "../scripts/catalogue/sync-api.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
export default createWikiApiVercelHandler(
  createCatalogueSyncApi({ root, storeBlob: createReferenceBlobStore() }),
);
