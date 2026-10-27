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
  resolveOwnerSession = null,
}) {
  return async (request) => {
    const url = new URL(request.url);
    if (
      ![
        "/api/automation/state",
        "/api/automation/command-ticket",
        "/api/automation/commands",
        "/api/automation/launch",
      ].includes(url.pathname) ||
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
    let input;
    try {
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
      const authorization = request.headers.get("authorization");
      const ownerInitData = request.headers.get("x-madhouse-wiki-init-data");
      if (authorization && ownerInitData)
        return json({ error: "game_session_required" }, 401);
      if (ownerInitData !== null) {
        if (ownerInitData.length > 4096 || !resolveOwnerSession)
          return json({ error: "game_session_required" }, 401);
        const owner = await resolveOwnerSession(ownerInitData);
        entry = await service.identifyOwner(owner.ownerId);
      } else entry = await service.identify(authorization);
      return json(
        request.method === "GET"
          ? service.snapshot(entry)
          : url.pathname.endsWith("/command-ticket")
            ? service.issueCommandTicket(entry, input)
            : url.pathname.endsWith("/launch")
              ? await service.launch(entry, input?.activeBossBattle)
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
            error.message === "automation_restore_confirmation_required"
              ? "automation_restore_confirmation_required"
              : error.message === "game_unavailable_actions_paused"
                ? "game_unavailable_actions_paused"
                : status === 400
                  ? "invalid_automation_command"
                  : status === 401
                    ? "game_session_required"
                    : status === 409
                      ? "automation_state_changed"
                      : "automation_unavailable",
          ...(["inventory.action", "inventory.refresh"].includes(
            input?.command,
          ) &&
          /^(inventory_[a-z_]+|automation_[a-z_]+|weapon_equipment_uncertain|subscription_controls_automation|character_upgrade_uncertain|character_batch_running|work_booster_uncertain|floor_automation_controls_resources|business_upgrade_uncertain)$/.test(
            error.message,
          )
            ? { inventoryReason: error.message }
            : {}),
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
