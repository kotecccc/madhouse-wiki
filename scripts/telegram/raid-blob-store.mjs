import { get, put } from "../storage/client.mjs";
import { strongBlobEtag } from "./raid-blob-etag.mjs";

const BLOB_PATH = "madhouse-raids/schedule.json";
const MAX_BLOB_SIZE = 1024 * 1024;
const MAX_RECORDS = 180;
const WRITE_ATTEMPTS = 4;

function defaultEnvelope() {
  return { schemaVersion: 1, posts: [] };
}

function compareVersions(left, right) {
  const leftTime =
    Date.parse(left.editedAt || left.publishedAt || left.removedAt || "") || 0;
  const rightTime =
    Date.parse(right.editedAt || right.publishedAt || right.removedAt || "") ||
    0;
  return leftTime - rightTime;
}

function sortRecords(posts) {
  return [...posts].sort((left, right) => {
    const dateOrder = String(right.raidDate || "").localeCompare(
      String(left.raidDate || ""),
    );
    return dateOrder || compareVersions(right, left);
  });
}

export function createRaidBlobStore({
  getBlob = get,
  putBlob = put,
  abortSignal,
} = {}) {
  async function readEnvelope() {
    const result = await getBlob(BLOB_PATH, {
      access: "private",
      useCache: false,
      ...(abortSignal ? { abortSignal } : {}),
    });
    if (!result) return { envelope: defaultEnvelope(), etag: null };
    if (result.statusCode !== 200 || result.blob.size > MAX_BLOB_SIZE)
      throw new Error("raid_store_unavailable");
    const parsed = JSON.parse(await new Response(result.stream).text());
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.posts))
      throw new Error("raid_store_unavailable");
    return { envelope: parsed, etag: strongBlobEtag(result.blob.etag) };
  }

  async function writeEnvelope(envelope, etag) {
    await putBlob(BLOB_PATH, JSON.stringify(envelope), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: etag !== null,
      ...(etag ? { ifMatch: etag } : {}),
      cacheControlMaxAge: 60,
      ...(abortSignal ? { abortSignal } : {}),
    });
  }

  async function replaceRecords(records) {
    if (!records.length) return 0;

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const { envelope, etag } = await readEnvelope();
      const postsById = new Map(
        envelope.posts.map((post) => [String(post.sourceMessageId), post]),
      );
      let changed = 0;

      for (const record of records) {
        const sourceMessageId = String(record.sourceMessageId);
        const nextRecord = { ...record, sourceMessageId };
        const current = postsById.get(sourceMessageId);
        if (current) {
          const versionOrder = compareVersions(current, nextRecord);
          if (versionOrder > 0) continue;
          if (
            versionOrder === 0 &&
            JSON.stringify(current) === JSON.stringify(nextRecord)
          )
            continue;
        }
        postsById.set(sourceMessageId, nextRecord);
        changed += 1;
      }

      if (!changed) return 0;
      const next = {
        schemaVersion: 1,
        posts: sortRecords([...postsById.values()]).slice(0, MAX_RECORDS),
      };
      try {
        await writeEnvelope(next, etag);
        return changed;
      } catch (error) {
        if (attempt === WRITE_ATTEMPTS - 1) throw error;
      }
    }
    return 0;
  }

  function removalRecord(sourceMessageId, removedAt) {
    return {
      sourceMessageId,
      removed: true,
      raidDate: "",
      publishedAt: null,
      removedAt,
    };
  }

  return {
    async readRecent(limit = 30) {
      const { envelope } = await readEnvelope();
      return sortRecords(envelope.posts)
        .filter((post) => !post.removed)
        .slice(0, limit);
    },
    async save(post) {
      return (await replaceRecords([post])) > 0;
    },
    saveMany(records) {
      return replaceRecords(records);
    },
    async remove(sourceMessageId, removedAt = new Date().toISOString()) {
      return (
        (await replaceRecords([removalRecord(sourceMessageId, removedAt)])) > 0
      );
    },
    removeMany(records) {
      return replaceRecords(
        records.map(({ sourceMessageId, removedAt }) =>
          removalRecord(sourceMessageId, removedAt),
        ),
      );
    },
    async removeMissing(
      sourceMessageIds,
      minimumMessageId,
      removedAt = new Date().toISOString(),
    ) {
      const present = new Set(sourceMessageIds.map(String));
      for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
        const { envelope, etag } = await readEnvelope();
        const posts = envelope.posts.map((post) => {
          if (
            post.removed ||
            Number(post.sourceMessageId) < minimumMessageId ||
            present.has(String(post.sourceMessageId))
          )
            return post;
          return { ...post, removed: true, removedAt };
        });
        if (posts.every((post, index) => post === envelope.posts[index]))
          return 0;
        try {
          await writeEnvelope({ schemaVersion: 1, posts }, etag);
          return posts.filter(
            (post, index) => post !== envelope.posts[index] && post.removed,
          ).length;
        } catch (error) {
          if (attempt === WRITE_ATTEMPTS - 1) throw error;
        }
      }
      return 0;
    },
  };
}
