import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX = new Map([
  ["madhouse-wiki/catalogue/reference.sqlite", 16 * 1024 * 1024],
  ["madhouse-raids/schedule.json", 1024 * 1024],
  ["madhouse-raids/telegram-session.enc.json", 16 * 1024],
  ["madhouse-raids/sync-lock.json", 2 * 1024],
]);

function json(res, status, message) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify({ error: message }));
}

function objectPath(url) {
  if (!url.startsWith("/v1/objects/")) return null;
  let name;
  try {
    name = decodeURIComponent(url.slice("/v1/objects/".length));
  } catch {
    return null;
  }
  return MAX.has(name) ? name : null;
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > limit) {
        oversized = true;
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("aborted", () =>
      reject(Object.assign(new Error("aborted"), { status: 400 })),
    );
    req.on("error", reject);
  });
}

function atomicWrite(file, body) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
    const dirFd = openSync(dirname(file), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The temporary file may already have been removed by the filesystem.
    }
    throw error;
  }
}

export function createStorageServer({
  host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 9091),
  root = process.env.MADHOUSE_STORAGE_DIR,
  token = process.env.MADHOUSE_STORAGE_TOKEN,
} = {}) {
  if (!root) throw new Error("MADHOUSE_STORAGE_DIR is required");
  if (typeof token !== "string" || Buffer.byteLength(token) < 32) {
    throw new Error("MADHOUSE_STORAGE_TOKEN must be at least 32 bytes");
  }
  const storageRoot = resolve(root);
  const expected = createHash("sha256").update(token).digest();

  const server = createServer(async (req, res) => {
    const supplied =
      /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
    const actual = createHash("sha256").update(supplied).digest();
    if (!timingSafeEqual(expected, actual))
      return json(res, 401, "unauthorized");

    const name = objectPath(req.url || "");
    if (!name) return json(res, 404, "not found");
    const file = join(storageRoot, name);

    if (req.method === "GET") {
      let body;
      try {
        body = readFileSync(file);
      } catch (error) {
        return json(
          res,
          error.code === "ENOENT" ? 404 : 500,
          error.code === "ENOENT" ? "not found" : "storage failure",
        );
      }
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": body.length,
        "cache-control": "no-store",
        etag,
      });
      return res.end(body);
    }

    if (req.method !== "PUT") return json(res, 405, "method not allowed");
    const limit = MAX.get(name);
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      req.resume();
      return json(res, 413, "object too large");
    }
    let body;
    try {
      body = await readBody(req, limit);
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          error.status || 400,
          error.status === 413 ? "object too large" : "invalid body",
        );
      return;
    }

    // No await occurs between the condition check and atomic replacement, so
    // concurrent requests are serialized by the Node event loop.
    const exists = existsSync(file);
    const current = exists ? readFileSync(file) : null;
    const currentEtag =
      current && `"${createHash("sha256").update(current).digest("hex")}"`;
    if (exists) {
      if (req.headers["if-match"] !== currentEtag)
        return json(res, 412, "etag mismatch");
    } else if (req.headers["if-none-match"] !== "*") {
      return json(res, 412, "object does not exist");
    }
    try {
      atomicWrite(file, body);
    } catch {
      return json(res, 500, "storage failure");
    }
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      etag,
    });
    res.end();
  });

  server.requestTimeout = 30_000;
  server.listen(port, host);
  return server;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const server = createStorageServer();
  server.on("listening", () => {
    const address = server.address();
    process.stdout.write(
      `storage server listening on ${address.address}:${address.port}\n`,
    );
  });
}
