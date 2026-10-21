const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export function createRaidVercelHandler(api) {
  return async (request, response) => {
    let result;
    try {
      const headers = new Headers();
      if (typeof request.headers.authorization === "string")
        headers.set("authorization", request.headers.authorization);
      result = await api(
        new Request(new URL(request.url || "/", "https://wiki.invalid"), {
          method: request.method || "GET",
          headers,
        }),
      );
    } catch {
      result = new Response(
        JSON.stringify({ error: "raid_schedule_unavailable" }),
        {
          status: 503,
          headers: PRIVATE_HEADERS,
        },
      );
    }
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
