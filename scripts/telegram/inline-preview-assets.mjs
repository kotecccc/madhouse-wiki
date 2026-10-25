const ALLOWED_IMAGE_ORIGIN = "https://cdn.cargohustle.online";
const DEFAULT_TIMEOUT_MS = 5000;

export async function fetchPreviewImage(
  url,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (new URL(url).origin !== ALLOWED_IMAGE_ORIGIN)
    return { asset: null, reason: "origin_not_allowed" };

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
      await response.body?.cancel();
      return {
        asset: null,
        reason: `http_${response.status}_${contentType || "no_content_type"}`,
      };
    }
    return {
      asset: {
        body: Buffer.from(await response.arrayBuffer()),
        contentType,
      },
      reason: null,
    };
  } catch (error) {
    return {
      asset: null,
      reason: error.cause?.code || error.name || "fetch_failed",
    };
  }
}

export function installPreviewImageLoader(
  page,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const failures = [];
  const cache = new Map();
  page.on("request", async (request) => {
    const url = request.url();
    if (
      request.resourceType() !== "image" ||
      !url.startsWith(`${ALLOWED_IMAGE_ORIGIN}/`)
    ) {
      await request.continue();
      return;
    }

    let result = cache.get(url);
    if (!result) {
      result = fetchPreviewImage(url, { timeoutMs });
      cache.set(url, result);
    }
    const { asset, reason } = await result;
    if (!asset) {
      failures.push({ url, reason });
      await request.abort("failed");
      return;
    }
    await request.respond({
      status: 200,
      contentType: asset.contentType,
      body: asset.body,
    });
  });
  return failures;
}

export function reportPreviewImageFailures(label, failures) {
  if (!failures.length) return;
  console.warn(
    `[${label}] Using built-in image placeholders for unavailable preview assets: ${JSON.stringify(failures)}`,
  );
}
