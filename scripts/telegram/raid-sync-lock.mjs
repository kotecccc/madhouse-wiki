import { randomUUID } from "node:crypto";
import { get, put } from "@vercel/blob";

const BLOB_PATH = "madhouse-raids/sync-lock.json";
const LOCK_TTL_MS = 10 * 60 * 1000;
const MAX_BLOB_SIZE = 2048;

export function createRaidSyncLock({ getBlob = get, putBlob = put } = {}) {
  return {
    async acquire(now = Date.now()) {
      const current = await getBlob(BLOB_PATH, {
        access: "private",
        useCache: false,
      });
      let etag = null;
      if (current) {
        if (current.statusCode !== 200 || current.blob.size > MAX_BLOB_SIZE)
          throw new Error("raid_sync_lock_unavailable");
        etag = current.blob.etag;
        let lock;
        try {
          lock = JSON.parse(await new Response(current.stream).text());
        } catch {
          throw new Error("raid_sync_lock_unavailable");
        }
        if (Number(lock?.expiresAt) > now) return null;
      }

      const token = randomUUID();
      const expiresAt = now + LOCK_TTL_MS;
      const result = await putBlob(
        BLOB_PATH,
        JSON.stringify({ token, expiresAt }),
        {
          access: "private",
          contentType: "application/json",
          addRandomSuffix: false,
          allowOverwrite: etag !== null,
          ...(etag ? { ifMatch: etag } : {}),
          cacheControlMaxAge: 60,
        },
      );
      return {
        async release() {
          try {
            await putBlob(BLOB_PATH, JSON.stringify({ token, expiresAt: 0 }), {
              access: "private",
              contentType: "application/json",
              addRandomSuffix: false,
              allowOverwrite: true,
              ifMatch: result.etag,
              cacheControlMaxAge: 60,
            });
          } catch {
            // The lock expires automatically if a conditional release loses a race.
          }
        },
      };
    },
  };
}
