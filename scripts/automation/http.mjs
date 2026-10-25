const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

export function createAutomationHttp({
  service,
  enabled = true,
  origin = null,
}) {
  return async (request) => {
    const url = new URL(request.url);
    if (
      !["/api/automation/state", "/api/automation/commands"].includes(
        url.pathname,
      ) ||
      url.search
    )
      return json({ error: "unknown_automation_route" }, 404);
    if (!enabled)
      return json({ error: "automation_game_requests_disabled" }, 503);
    const expectedMethod = url.pathname.endsWith("/state") ? "GET" : "POST";
    if (request.method !== expectedMethod)
      return json({ error: "method_not_allowed" }, 405);
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== (origin || url.origin)
    )
      return json({ error: "origin_rejected" }, 403);
    let entry;
    try {
      let input;
      if (request.method === "POST") {
        if (
          request.headers.get("content-type")?.split(";")[0] !==
          "application/json"
        )
          return json({ error: "json_required" }, 415);
        const reader = request.body?.getReader();
        if (!reader) return json({ error: "command_required" }, 400);
        const chunks = [];
        let bytes = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 16384) {
            await reader.cancel();
            return json({ error: "body_too_large" }, 413);
          }
          chunks.push(Buffer.from(value));
        }
        try {
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
      }
      entry = await service.identify(request.headers.get("authorization"));
      return json(
        request.method === "GET"
          ? service.snapshot(entry)
          : await service.command(entry, input),
      );
    } catch (error) {
      const status =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : error instanceof RangeError || error instanceof TypeError
            ? 400
            : 503;
      return json(
        {
          error:
            error.message === "game_unavailable_actions_paused"
              ? "game_unavailable_actions_paused"
              : status === 400
                ? "invalid_automation_command"
                : status === 401
                  ? "game_session_required"
                  : status === 409
                    ? "automation_state_changed"
                    : "automation_unavailable",
          ...(entry ? { gameHealth: service.snapshot(entry).gameHealth } : {}),
          ...(entry && status === 409
            ? { snapshot: service.snapshot(entry) }
            : {}),
        },
        status,
      );
    }
  };
}

// Shared native-HTTP adapter for Vite DEV and the VPS runtime; no upstream proxy.
export function nodeAutomationHandler(handle, { origin } = {}) {
  return async (request, response) => {
    let bytes = 0;
    const chunks = [];
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 16384) {
            response.writeHead(413, headers);
            response.end(JSON.stringify({ error: "body_too_large" }));
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      const result = await handle(
        new Request(
          `${origin || `http://${request.headers.host}`}${request.url}`,
          {
            method: request.method,
            headers: request.headers,
            ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
          },
        ),
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(503, headers);
      response.end(JSON.stringify({ error: "automation_unavailable" }));
    }
  };
}
