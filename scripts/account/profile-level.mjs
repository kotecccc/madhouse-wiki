export function createProfileLevelHandler({ identity, readProgress, origin }) {
  return async (request) => {
    const headers = {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    };
    const url = new URL(request.url);
    if (request.method !== "GET")
      return new Response(null, { status: 405, headers });
    if (
      url.search ||
      (request.headers.get("origin") &&
        request.headers.get("origin") !== (origin || url.origin))
    )
      return new Response(null, { status: 403, headers });
    const authorization = request.headers.get("authorization");
    let player;
    try {
      player = await identity(authorization);
    } catch {
      return new Response(null, { status: 401, headers });
    }
    if (!Number.isSafeInteger(player?.playerId))
      return new Response(null, { status: 401, headers });
    const progress = await readProgress(
      { playerId: player.playerId },
      authorization,
    );
    if (!Number.isSafeInteger(progress.exp?.level))
      return new Response(null, { status: 503, headers });
    return new Response(
      JSON.stringify({ playerId: player.playerId, level: progress.exp.level }),
      { headers },
    );
  };
}
