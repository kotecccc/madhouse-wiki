import {
  get as blobGet,
  put as blobPut,
  BlobPreconditionFailedError,
} from "@vercel/blob";

export { BlobPreconditionFailedError };

function configuredOrigin() {
  const origin = process.env.MADHOUSE_STORAGE_ORIGIN;
  const token = process.env.MADHOUSE_STORAGE_TOKEN;
  if (!origin && !token) return null;
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
  return { url: origin.replace(/\/$/, ""), token };
}

function endpoint(config, path) {
  return `${config.url}/v1/objects/${encodeURIComponent(path)}`;
}

async function request(path, init) {
  const config = configuredOrigin();
  if (!config) return null;
  const response = await fetch(endpoint(config, path), {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${config.token}`,
    },
    redirect: "error",
  });
  return response;
}

export async function get(path, options = {}) {
  const requestOptions = {
    method: "GET",
    signal: options.abortSignal,
    headers: {},
  };
  const response = await request(path, requestOptions);
  if (!response) return blobGet(path, options);
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw new Error(`madhouse_storage_get_failed:${response.status}`);
  const size = Number(response.headers.get("content-length"));
  return {
    statusCode: 200,
    blob: {
      size: Number.isFinite(size) ? size : 0,
      etag: response.headers.get("etag"),
    },
    stream: response.body,
  };
}

export async function put(path, body, options = {}) {
  const headers = {
    "content-type": options.contentType || "application/octet-stream",
  };
  if (options.ifMatch) headers["if-match"] = options.ifMatch;
  else if (options.allowOverwrite === false) headers["if-none-match"] = "*";
  const response = await request(path, {
    method: "PUT",
    body,
    signal: options.abortSignal,
    headers,
  });
  if (!response) return blobPut(path, body, options);
  if (response.status === 412) throw new BlobPreconditionFailedError();
  if (!response.ok)
    throw new Error(`madhouse_storage_put_failed:${response.status}`);
  return {
    url: endpoint(configuredOrigin(), path),
    etag: response.headers.get("etag"),
  };
}
