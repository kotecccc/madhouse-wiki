import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export function createFileBackedCredentialStorage(directory) {
  const root = resolve(directory);

  function locationFor(path) {
    if (typeof path !== "string" || path.length < 1)
      throw new TypeError("credential_fixture_path_invalid");
    const location = resolve(root, path);
    const relativePath = relative(root, location);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath.startsWith(sep)
    )
      throw new TypeError("credential_fixture_path_invalid");
    return location;
  }

  async function read(path) {
    try {
      return JSON.parse(await readFile(locationFor(path), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function write(path, value, expectedEtag) {
    const location = locationFor(path);
    const current = await read(path);
    if ((current?.etag ?? null) !== expectedEtag) {
      const error = new Error("storage_precondition_failed");
      error.code = "storage_precondition_failed";
      throw error;
    }
    const etag = randomUUID();
    const temporary = `${location}.${randomUUID()}.tmp`;
    await mkdir(dirname(location), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ value, etag }), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, location);
    return { etag };
  }

  return Object.freeze({ read, write });
}
