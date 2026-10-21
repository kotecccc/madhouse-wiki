import { get, put } from "@vercel/blob";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strongBlobEtag } from "../telegram/raid-blob-etag.mjs";

const BLOB_PATH = "madhouse-wiki/catalogue/reference.sqlite";
const MAX_SIZE = 16 * 1024 * 1024;

export function createReferenceBlobStore({
  getBlob = get,
  putBlob = put,
} = {}) {
  async function download() {
    const result = await getBlob(BLOB_PATH, {
      access: "private",
      useCache: false,
    });
    if (!result) return null;
    if (result.statusCode !== 200 || result.blob.size > MAX_SIZE)
      throw new Error("catalogue_unavailable");
    const directory = await mkdtemp(join(tmpdir(), "madhouse-catalogue-"));
    const file = join(directory, "madhouse.sqlite");
    try {
      await writeFile(
        file,
        Buffer.from(await new Response(result.stream).arrayBuffer()),
      );
      return { directory, file, etag: strongBlobEtag(result.blob.etag) };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async function upload(file, etag) {
    const data = await readFile(file);
    if (data.length > MAX_SIZE) throw new Error("catalogue_unavailable");
    await putBlob(BLOB_PATH, data, {
      access: "private",
      contentType: "application/vnd.sqlite3",
      addRandomSuffix: false,
      allowOverwrite: etag !== null,
      ...(etag ? { ifMatch: etag } : {}),
      cacheControlMaxAge: 0,
    });
  }
  return { download, upload };
}
