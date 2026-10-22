import { randomUUID } from "node:crypto";
import { BlobPreconditionFailedError, get, put } from "../storage/client.mjs";
import { strongBlobEtag } from "./raid-blob-etag.mjs";

const BLOB_PATH = "madhouse-raids/sync-lock.json";
const LOCK_TTL_MS = 2 * 60 * 1000;
const MAX_BLOB_SIZE = 2048;

export function createRaidSyncLock({
  getBlob = get,
  putBlob = put,
  abortSignal,
} = {}) {
  async function read() {
    const current = await getBlob(BLOB_PATH, {
      access: "private",
      useCache: false,
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (!current) return { value: null, etag: null };
    if (current.statusCode !== 200 || current.blob.size > MAX_BLOB_SIZE)
      throw new Error("raid_sync_lock_unavailable");

    let value;
    try {
      value = JSON.parse(await new Response(current.stream).text());
    } catch {
      throw new Error("raid_sync_lock_unavailable");
    }
    if (
      typeof value?.token !== "string" ||
      !Number.isFinite(Number(value.expiresAt))
    )
      throw new Error("raid_sync_lock_unavailable");
    return { value, etag: strongBlobEtag(current.blob.etag) };
  }

  async function write(value, etag) {
    return putBlob(BLOB_PATH, JSON.stringify(value), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: etag !== null,
      ...(etag ? { ifMatch: etag } : {}),
      cacheControlMaxAge: 0,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  return {
    async acquire(now = Date.now()) {
      const current = await read();
      if (current.value && Number(current.value.expiresAt) > now) return null;

      const token = randomUUID();
      try {
        await write({ token, expiresAt: now + LOCK_TTL_MS }, current.etag);
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) return null;
        throw error;
      }
      let released = false;

      return {
        async assertActive(assertAt = Date.now()) {
          if (released) throw new Error("raid_sync_lock_lost");
          const active = await read();
          if (
            active.value?.token !== token ||
            Number(active.value.expiresAt) <= assertAt
          )
            throw new Error("raid_sync_lock_lost");
        },
        async renew(renewAt = Date.now()) {
          if (released) throw new Error("raid_sync_lock_lost");
          const active = await read();
          if (
            active.value?.token !== token ||
            Number(active.value.expiresAt) <= renewAt
          )
            throw new Error("raid_sync_lock_lost");

          try {
            const renewed = await write(
              { token, expiresAt: renewAt + LOCK_TTL_MS },
              active.etag,
            );
            if (!renewed.etag) throw new Error("raid_sync_lock_lost");
          } catch {
            throw new Error("raid_sync_lock_lost");
          }
        },
        async release() {
          if (released) return;
          released = true;
          try {
            const active = await read();
            if (active.value?.token !== token) return;
            await write({ token, expiresAt: 0 }, active.etag);
          } catch {
            // The lock expires automatically if a conditional release loses a race.
          }
        },
      };
    },
  };
}
