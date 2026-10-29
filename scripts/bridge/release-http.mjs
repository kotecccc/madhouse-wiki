import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

const files = new Map([
  [
    "/bridge/bootstrap.pyz",
    ["bootstrap.pyz", 2 * 1024 * 1024, "application/octet-stream"],
  ],
  [
    "/bridge/releases/madhouse-bridge.pyz",
    [
      "releases/madhouse-bridge.pyz",
      2 * 1024 * 1024,
      "application/octet-stream",
    ],
  ],
  [
    "/bridge/releases/manifest.json",
    ["releases/manifest.json", 4096, "application/json; charset=utf-8"],
  ],
  [
    "/bridge/releases/manifest.sig",
    ["releases/manifest.sig", 64, "application/octet-stream"],
  ],
]);
const macDownload = [
  "MadhouseWikiBridge-macOS.zip",
  2 * 1024 * 1024,
  "application/zip",
];
const windowsDownload = [
  "MadhouseWikiBridge-Windows.zip",
  32 * 1024 * 1024,
  "application/zip",
];
const windowsFiles = new Map([
  [
    "/bridge/windows-releases/madhouse-bridge.pyz",
    [
      "windows-releases/madhouse-bridge.pyz",
      2 * 1024 * 1024,
      "application/octet-stream",
    ],
  ],
  [
    "/bridge/windows-releases/manifest.json",
    ["windows-releases/manifest.json", 4096, "application/json; charset=utf-8"],
  ],
  [
    "/bridge/windows-releases/manifest.sig",
    ["windows-releases/manifest.sig", 64, "application/octet-stream"],
  ],
]);
const windowsArchiveSha =
  "57d04c31fef2dee9380de6d01f6bfbe8510294e67cff703c5363afb53208f161";

/** Verify public files are readable and the bootstrap matches the Wiki build. */
export function verifyBridgeRelease(directory, bootstrapSha) {
  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    !/^[a-f0-9]{64}$/.test(bootstrapSha || "")
  )
    throw new Error("bridge_release_invalid");
  try {
    for (const [relative, limit] of files.values()) {
      const fd = openSync(
        join(directory, relative),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size < 1 || info.size > limit)
          throw new Error();
        const data = readFileSync(fd);
        if (data.length !== info.size) throw new Error();
        if (
          relative === "bootstrap.pyz" &&
          createHash("sha256").update(data).digest("hex") !== bootstrapSha
        )
          throw new Error();
      } finally {
        closeSync(fd);
      }
    }
  } catch {
    throw new Error("bridge_release_invalid");
  }
}

/** Serve only the already prepared public artifacts; never expose signing keys. */
export function createBridgeReleaseHttp(
  directory,
  { windowsSha256 = windowsArchiveSha } = {},
) {
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new TypeError("bridge_release_directory_required");
  if (!/^[a-f0-9]{64}$/.test(windowsSha256))
    throw new TypeError("invalid_windows_archive_hash");
  return (request, response) => {
    const entry =
      files.get(request.url) ||
      windowsFiles.get(request.url) ||
      (request.url === "/bridge/MadhouseWikiBridge-macOS.zip"
        ? macDownload
        : request.url === "/bridge/MadhouseWikiBridge-Windows.zip"
          ? windowsDownload
          : null);
    if (!entry || !["GET", "HEAD"].includes(request.method)) {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    let fd;
    try {
      fd = openSync(
        join(directory, entry[0]),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = fstatSync(fd);
      if (!info.isFile() || info.size < 1 || info.size > entry[1])
        throw new Error();
      const data = readFileSync(fd);
      if (data.length !== info.size) throw new Error();
      if (
        entry === windowsDownload &&
        createHash("sha256").update(data).digest("hex") !== windowsSha256
      )
        throw new Error();
      response.writeHead(200, {
        "Content-Type": entry[2],
        "Content-Length": data.length,
        ...(entry === macDownload || entry === windowsDownload
          ? {
              "Content-Disposition": `attachment; filename="${entry[0]}"`,
            }
          : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
}
