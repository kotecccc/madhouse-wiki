import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

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

/** Serve only the already prepared public artifacts; never expose signing keys. */
export function createBridgeReleaseHttp(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory))
    throw new TypeError("bridge_release_directory_required");
  return (request, response) => {
    const entry = files.get(request.url);
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
      response.writeHead(200, {
        "Content-Type": entry[2],
        "Content-Length": data.length,
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
