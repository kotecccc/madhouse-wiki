const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });
export const localStopCommands = new Set([
  "auto.stop",
  "goal.stop",
  "raid.stop",
  "floor.stop",
  "work.stop",
  "character.stop",
  "business.run.stop",
  "subscription.stop",
  "buddy.stop",
  "queue.cancel",
]);

export function createAutomationHttp({
  service,
  enabled = true,
  origin = null,
}) {
  return async (request) => {
    const url = new URL(request.url);
    if (
      ![
        "/api/automation/state",
        "/api/automation/commands",
        "/api/automation/launch",
        "/api/automation/friends",
        "/api/automation/friends/refresh",
      ].includes(url.pathname) ||
      url.search
    )
      return json({ error: "unknown_automation_route" }, 404);
    if (!enabled)
      return json({ error: "automation_game_requests_disabled" }, 503);
    const expectedMethod = [
      "/api/automation/state",
      "/api/automation/friends",
    ].includes(url.pathname)
      ? "GET"
      : "POST";
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
      const isStop = localStopCommands.has(input?.command);
      const authorization = request.headers.get("authorization");
      entry =
        request.method === "GET" || isStop
          ? await service.readStored(authorization)
          : ["queue.enqueue", "queue.resume"].includes(input?.command) &&
              service.identifyForQueue
            ? await service.identifyForQueue(authorization)
            : await service.identify(authorization);
      return json(
        request.method === "GET"
          ? url.pathname.endsWith("/friends")
            ? service.friends(entry, request.headers.get("authorization"))
            : service.snapshot(entry)
          : url.pathname.endsWith("/friends/refresh")
            ? await service.refreshFriends(
                entry,
                request.headers.get("authorization"),
                { ifStale: input?.ifStale === true },
              )
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
      if (status === 503) {
        const reasons = new Set([
          "automation_unavailable",
          "automation_worker_unavailable",
          "automation_storage_unavailable",
          "game_identity_unavailable",
          "bridge_unavailable",
        ]);
        console.warn(
          "madhouse-automation-diagnostic",
          reasons.has(error?.message) ? error.message : "other",
        );
      }
      return json(
        {
          error:
            error.message === "game_unavailable_actions_paused"
              ? "game_unavailable_actions_paused"
              : status === 404 && error.message === "automation_state_unknown"
                ? "automation_state_unknown"
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
          ...(status === 409 && error.message === "automation_state_changed"
            ? { conflictReason: "version" }
            : {}),
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
