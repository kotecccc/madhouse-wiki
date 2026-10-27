import { get, put } from "../scripts/storage/client.mjs";
// Server-only private storage. Names are HMACs; content is AES-GCM encrypted.
// Consistent reads + conditional writes preserve logout under concurrent logins.
export function createBlobSessionStore() {
  return {
    async read(pathname) {
      const result = await get(pathname, {
        access: "private",
        useCache: false,
      });
      if (!result) return null;
      if (result.statusCode !== 200 || result.blob.size > 32768)
        throw new Error("session_store_unavailable");
      return {
        value: await new Response(result.stream).text(),
        etag: result.blob.etag,
      };
    },
    async write(pathname, value, etag) {
      return put(pathname, value, {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: etag !== null,
        ...(etag ? { ifMatch: etag } : {}),
        cacheControlMaxAge: 60,
      });
    },
  };
}
