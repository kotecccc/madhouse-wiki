// Server-only client for the private Madhouse storage service.
// Production storage is deliberately fail-closed when credentials are absent.
export class BlobPreconditionFailedError extends Error {
  constructor() {
    super("storage_precondition_failed");
    this.name = "BlobPreconditionFailedError";
  }
}

function configuredOrigin() {
  const origin = process.env.MADHOUSE_STORAGE_ORIGIN;
  const token = process.env.MADHOUSE_STORAGE_TOKEN;
  if (!origin || !token || token.length < 32)
    throw new Error("madhouse_storage_config_unavailable");

  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("madhouse_storage_config_unavailable");
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !["https:", ...(localhost ? ["http:"] : [])].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("madhouse_storage_config_unavailable");
  return { url: origin.replace(/\/$/u, ""), token };
}

function objectEndpoint(config, path) {
  return `${config.url}/v1/objects/${encodeURIComponent(path)}`;
}

function makeUrl(config, path, params = {}) {
  const url = new URL(`${config.url}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "")
      url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function request(url, init, config = configuredOrigin()) {
  return fetch(url, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${config.token}`,
    },
    redirect: "error",
  });
}

function toBlob(response, body) {
  const size = Number(response.headers.get("content-length"));
  return {
    statusCode: 200,
    blob: {
      size: Number.isFinite(size) ? size : 0,
      etag: response.headers.get("etag"),
    },
    stream: body,
  };
}

export async function get(path, options = {}) {
  const config = configuredOrigin();
  const response = await request(
    objectEndpoint(config, path),
    {
      method: "GET",
      signal: options.abortSignal,
      headers: {},
    },
    config,
  );
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw new Error(`madhouse_storage_get_failed:${response.status}`);
  return toBlob(response, response.body);
}

export async function put(path, body, options = {}) {
  const config = configuredOrigin();
  const headers = {
    "content-type": options.contentType || "application/octet-stream",
  };
  if (options.ifMatch) headers["if-match"] = options.ifMatch;
  else if (options.allowOverwrite === false) headers["if-none-match"] = "*";
  const response = await request(
    objectEndpoint(config, path),
    {
      method: "PUT",
      body,
      signal: options.abortSignal,
      headers,
    },
    config,
  );
  if (response.status === 412) throw new BlobPreconditionFailedError();
  if (!response.ok)
    throw new Error(`madhouse_storage_put_failed:${response.status}`);
  return {
    url: objectEndpoint(config, path),
    etag: response.headers.get("etag"),
  };
}

export async function list({ prefix = "", limit = 1000, cursor } = {}) {
  const config = configuredOrigin();
  const url = makeUrl(config, "/v1/list", { prefix, limit, cursor });
  const response = await request(url, { method: "GET", headers: {} }, config);
  if (!response.ok)
    throw new Error(`madhouse_storage_list_failed:${response.status}`);
  const result = await response.json();
  if (!result || !Array.isArray(result.blobs))
    throw new Error("madhouse_storage_list_invalid");
  return result;
}

export async function del(pathOrPaths, options = {}) {
  const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
  const config = configuredOrigin();
  for (const path of paths) {
    const headers = {};
    if (!Array.isArray(pathOrPaths) && options.ifMatch)
      headers["if-match"] = options.ifMatch;
    const response = await request(
      objectEndpoint(config, path),
      {
        method: "DELETE",
        headers,
      },
      config,
    );
    if (response.status === 412) throw new BlobPreconditionFailedError();
    if (
      response.status !== 200 &&
      response.status !== 204 &&
      response.status !== 404
    )
      throw new Error(`madhouse_storage_delete_failed:${response.status}`);
  }
}
