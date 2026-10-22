import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  lstatSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
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
const SESSION_PATH = /^accounts\/[a-f0-9]{64}\.json$/u;
const ANALYTICS_PREFIX = "madhouse-wiki/analytics/events/";
const ANALYTICS_PATH =
  /^madhouse-wiki\/analytics\/events\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/u;
const SESSION_MAX = 32 * 1024;
const ANALYTICS_MAX = 64 * 1024;

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
  return MAX.has(name) || SESSION_PATH.test(name) || ANALYTICS_PATH.test(name)
    ? name
    : null;
}

function safeFile(root, name) {
  const parts = name.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Missing parents are ordinary for reads and are created by atomicWrite.
      break;
    }
  }
  const file = join(root, name);
  try {
    if (lstatSync(file).isSymbolicLink()) return null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return file;
}

function success(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function analyticsName(name) {
  return ANALYTICS_PATH.test(name);
}

function listAnalytics(root, prefix, limit, cursor) {
  const base = join(root, "madhouse-wiki", "analytics", "events");
  const found = [];
  const walk = (directory, relative) => {
    if (found.length >= limit + 1) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= limit + 1) return;
      if (entry.isSymbolicLink()) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) {
        const pathname = `${ANALYTICS_PREFIX}${childRelative}`;
        if (
          analyticsName(pathname) &&
          pathname.startsWith(prefix) &&
          pathname > cursor
        ) {
          const stat = lstatSync(child);
          found.push({
            pathname,
            size: stat.size,
            uploadedAt: stat.mtime.toISOString(),
          });
        }
      }
    }
  };
  walk(base, "");
  found.sort((a, b) =>
    a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0,
  );
  const page = found.slice(0, limit + 1);
  const hasMore = page.length > limit;
  const blobs = page.slice(0, limit);
  return { blobs, hasMore, cursor: hasMore ? blobs.at(-1).pathname : null };
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

    let parsed;
    try {
      parsed = new URL(req.url || "/", "http://storage.local");
    } catch {
      return json(res, 400, "invalid request");
    }
    if (parsed.pathname === "/v1/list") {
      const prefix = parsed.searchParams.get("prefix") || "";
      const limitText = parsed.searchParams.get("limit") || "1000";
      const limit = Number(limitText);
      const cursor = parsed.searchParams.get("cursor") || "";
      if (
        req.method !== "GET" ||
        !/^madhouse-wiki\/analytics\/events\/(?:\d{4}-\d{2}-\d{2}\/)?$/u.test(
          prefix,
        ) ||
        !/^\d{1,4}$/u.test(limitText) ||
        limit < 1 ||
        limit > 1000 ||
        (cursor && (!analyticsName(cursor) || !cursor.startsWith(prefix)))
      )
        return json(res, 400, "invalid list request");
      try {
        return success(
          res,
          200,
          listAnalytics(storageRoot, prefix, limit, cursor),
        );
      } catch {
        return json(res, 500, "storage failure");
      }
    }
    const name = objectPath(parsed.pathname);
    if (!name) return json(res, 404, "not found");
    const file = safeFile(storageRoot, name);
    if (!file) return json(res, 404, "not found");

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

    if (req.method === "DELETE") {
      if (!analyticsName(name)) return json(res, 405, "method not allowed");
      try {
        const exists = existsSync(file);
        if (exists && req.headers["if-match"]) {
          const current = readFileSync(file);
          const etag = `"${createHash("sha256").update(current).digest("hex")}"`;
          if (req.headers["if-match"] !== etag)
            return json(res, 412, "etag mismatch");
        }
        if (exists) unlinkSync(file);
        return success(res, 200, {});
      } catch {
        return json(res, 500, "storage failure");
      }
    }
    if (req.method !== "PUT") return json(res, 405, "method not allowed");
    const limit =
      MAX.get(name) || (SESSION_PATH.test(name) ? SESSION_MAX : ANALYTICS_MAX);
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
